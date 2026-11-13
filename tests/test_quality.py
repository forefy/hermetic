"""Quality by provider: replies matched to the call that made them, per-day counts, what endpoints declare
and the changes between days, and the daily check's result and the changes it sees.

Run inside Hermes' environment: bash ~/.hermes/hermes-agent/scripts/run-in-hermes-env python3 tests/test_quality.py
"""
import asyncio
import importlib.util
import json
import math
import shutil
import sys
import time
from pathlib import Path

from _home import throwaway_home

HERE = Path(__file__).resolve().parent
HOME = throwaway_home("hermetic-quality-test-")  # a throwaway profile, never the real one

spec = importlib.util.spec_from_file_location("plugin_api", HERE.parent / "dashboard" / "plugin_api.py")
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)
api._profile_home = lambda profile: ("default", HOME)

NOW = time.time()


def call(ts, session, upstream, model="x/m", output=100, secs=2.0, reasoning=50, finish="stop"):
    return {"ts": ts, "session": session, "upstream": upstream, "model": model, "output": output, "secs": secs,
            "reasoning": reasoning, "finish": finish}


def test_a_reply_goes_to_the_call_that_made_it():
    calls = [call(NOW - 300, "s1", "A"), call(NOW - 200, "s1", "B"), call(NOW - 100, "s2", "C")]
    got = api._q_attribute(calls, [("s1", NOW - 199, True), ("s1", NOW - 290, False), ("s2", NOW - 99, False), ("gone", NOW, True)])
    assert [(r["upstream"], pushed) for r, _ts, pushed in got] == [("B", True), ("A", False), ("C", False)], got
    assert api._q_attribute(calls, [("s1", NOW - 400, True)]) == [], "a reply before any call has no provider"


def test_endpoint_changes_between_days():
    (HOME / "hermetic" / "quality").mkdir(parents=True, exist_ok=True)
    path = HOME / "hermetic" / "quality" / "endpoints.jsonl"
    path.write_text("\n".join(json.dumps(r) for r in [
        {"day": "2026-10-30", "model": "x/m", "provider": "A", "tag": "a", "quant": "fp8", "ctx": 200000, "max_out": 32000, "logprobs": True},
        {"day": "2026-10-30", "model": "x/m", "provider": "B", "tag": "b", "quant": None, "ctx": 128000, "max_out": 8000, "logprobs": False}]) + "\n")
    fetched = []

    def fetch(model):
        fetched.append(model)
        return {"data": {"endpoints": [
            {"provider_name": "A", "tag": "a", "quantization": "fp4", "context_length": 100000, "max_completion_tokens": 32000, "supported_parameters": ["tools"]},
            {"provider_name": "B", "tag": "b", "quantization": "unknown", "context_length": 128000, "max_completion_tokens": 8000, "supported_parameters": ["logprobs"]}]}}
    latest, events = api._q_endpoints(HOME, ["x/m"], fetch=fetch)
    assert fetched == ["x/m"] and latest["x/m"]["A"][0]["quant"] == "fp4" and latest["x/m"]["B"][0]["quant"] is None
    whats = sorted(w for _d, _m, p, w in events if p == "A")
    assert whats == ["Context window cut from 200,000 to 100,000 tokens", "Precision changed from fp8 to fp4", "Stopped offering logprobs"], whats
    assert not [e for e in events if e[2] == "B"], "nothing changed for B"
    api._q_endpoints(HOME, ["x/m"], fetch=fetch)
    assert fetched == ["x/m"], "fetched once a day"


def test_the_daily_check_reads_answer_certainty_tokens_and_version():
    sent = []
    resp = {"id": "gen-1", "provider": "A", "usage": {"prompt_tokens": 19, "cost": 0.00003},
            "choices": [{"message": {"content": "ok"}, "logprobs": {"content": [
                {"token": "ok", "logprob": -2.0}, {"token": "</think>", "logprob": -0.1}, {"token": "ok", "logprob": -0.001}]}}]}
    api.time.sleep, saved = (lambda s: None), api.time.sleep
    try:
        out = api._q_check_one({"api_key": "k", "base_url": "https://openrouter.ai/api/v1"}, {"zdr": True}, "x/m", "a/fp8", True,
                               post=lambda b: sent.append(b) or resp,
                               lookup=lambda gid: {"data": {"provider_responses": [{"model_permaslug": "x/m-2026", "endpoint_id": "e1"}]}})
    finally:
        api.time.sleep = saved
    body = sent[0]
    assert body["provider"] == {"zdr": True, "order": ["a/fp8"], "allow_fallbacks": False} and body["logprobs"] is True
    assert out["answer"] == "ok" and abs(out["sure"] - math.exp(-0.001)) < 1e-6, "the last ok is the answer, after the thinking"
    assert out["prompt_tokens"] == 19 and out["version"] == "x/m-2026" and out["endpoint"] == "e1"
    failed = api._q_check_one({"api_key": "k", "base_url": "u"}, {}, "x/m", "a", False, post=lambda b: (_ for _ in ()).throw(RuntimeError("404 no endpoint")))
    assert failed == {"error": "404 no endpoint"}


def test_the_daily_check_notices_changes():
    checks = [{"ts": 1, "day": "2026-10-30", "model": "x/m", "provider": "A", "prompt_tokens": 19, "version": "v1", "sure": 0.999},
              {"ts": 2, "day": "2026-10-31", "model": "x/m", "provider": "A", "error": "timeout"},
              {"ts": 3, "day": "2026-11-01", "model": "x/m", "provider": "A", "prompt_tokens": 23, "version": "v2", "sure": 0.95}]
    whats = [w for _d, _m, _p, w in api._q_check_events(checks)]
    assert len(whats) == 2 and "23 tokens, it was 19" in whats[0] and "95.0%" in whats[1], whats


def test_every_provider_gets_its_version_from_its_own_calls():
    (HOME / "hermetic" / "quality").mkdir(parents=True, exist_ok=True)
    (HOME / "hermetic" / "quality" / "versions.jsonl").unlink(missing_ok=True)
    today, yesterday = NOW, NOW - 86400
    calls = [dict(call(yesterday, "s1", "A"), gen="g-a-old"), dict(call(today - 60, "s1", "A"), gen="g-a1"), dict(call(today - 30, "s1", "A"), gen="g-a2"),
             dict(call(today - 20, "s2", "B"), gen="g-b"), call(today - 10, "s2", "C"), dict(call(NOW - 9 * 86400, "s3", "A"), gen="g-ancient")]
    asked = []

    def lookup(gid):
        asked.append(gid)
        if gid == "g-b":
            raise RuntimeError("404 not stored yet")
        return {"data": {"model": "x/m", "provider_responses": [{"model_permaslug": "x/m-2026" if gid == "g-a-old" else "x/m-2027", "endpoint_id": "e-" + gid}]}}
    assert api._q_lookup_versions(HOME, calls, lookup=lookup) == 2
    assert sorted(asked) == ["g-a-old", "g-a2", "g-b"], "the newest call per provider and day, within a week, only calls with an id"
    rows = api._aai_read(HOME / "hermetic" / "quality" / "versions.jsonl")
    assert {(r["provider"], r["day"], r["version"]) for r in rows} == {("A", api._q_day(yesterday), "x/m-2026"), ("A", api._q_day(today), "x/m-2027")}
    asked.clear()
    assert api._q_lookup_versions(HOME, calls, lookup=lookup) == 0 and asked == [], "known days are not looked up again, a missing record waits 10 minutes"
    api._Q_GEN_TRIED["g-b"] -= 601
    api._q_lookup_versions(HOME, calls, lookup=lookup)
    assert asked == ["g-b"], asked
    whats = [w for _d, _m, p, w in api._q_version_events(rows) if p == "A"]
    assert whats == ["Model version changed from x/m-2026 to x/m-2027"], whats


def test_each_openrouter_call_keeps_its_generation_id():
    spec2 = importlib.util.spec_from_file_location("hermetic_init_q", HERE.parent / "__init__.py")
    plugin = importlib.util.module_from_spec(spec2)
    spec2.loader.exec_module(plugin)
    plugin._EXEC["r9"] = {"gen": "gen-123", "native": "stop"}
    plugin._on_post_api_request(provider="openrouter", base_url="https://openrouter.ai/api/v1", api_request_id="r9", session_id="s9",
                                response={"model": "x/m", "upstream_provider": "A"}, usage={"input_tokens": 1, "output_tokens": 1}, model="x/m")
    row = json.loads((HOME / "hermetic" / "routing.jsonl").read_text().splitlines()[-1])
    assert row["gen"] == "gen-123" and row["upstream"] == "A", row


def test_the_route_counts_calls_and_replies_per_provider_and_day():
    (HOME / "hermetic").mkdir(exist_ok=True)
    rows = [call(NOW - 60, "s1", "A"), call(NOW - 50, "s1", "A", finish="length", output=0), call(NOW - 40, "s2", "B", secs=4.0),
            call(NOW - 30, "s2", "B")]
    (HOME / "hermetic" / "routing.jsonl").write_text("\n".join(json.dumps(r) for r in rows) + "\n")
    (HOME / "hermetic" / "quality" / "endpoints.jsonl").unlink(missing_ok=True)
    api._q_replies = lambda profile, since: [("s1", NOW - 49, True), ("s2", NOW - 29, False)]
    api._q_endpoints = lambda home, models, fetch=None: ({"x/m": {"A": [{"quant": "fp4", "tag": "a/fp4"}]}}, [])
    out = asyncio.run(api.quality(profile=None))
    m = out["models"][0]
    day = api._q_day(NOW - 60)
    a = next(p for p in m["providers"] if p["name"] == "A")
    b = next(p for p in m["providers"] if p["name"] == "B")
    assert a["days"][day] == [2, 1, 1, 100, 2.0, 100, 1, 0], a["days"]
    assert b["days"][day] == [2, 1, 0, 200, 6.0, 100, 0, 0], b["days"]
    assert a["quant"] == "fp4" and a["tag"] == "a/fp4" and b["quant"] is None
    assert out["check"] == {"enabled": False, "last": None}


def test_turning_the_check_on_runs_it_once_a_day():
    started = []
    saved = api._q_start_checks
    api._q_start_checks = lambda profile: started.append(profile)
    try:
        assert asyncio.run(api.quality_check({"enabled": True}, profile=None)) == {"ok": True, "enabled": True}
        assert started == [None]
        s = api._q_settings(HOME)
        s["last"] = time.time()
        api._q_save_settings(HOME, s)
        asyncio.run(api.quality_check({"enabled": True}, profile=None))
        assert started == [None], "not again within the day"
        asyncio.run(api.quality_check({"enabled": False}, profile=None))
        assert api._q_settings(HOME)["check"] is False
    finally:
        api._q_start_checks = saved



def test_another_profile_is_checked_with_its_own_key_and_privacy_rules():
    other = HOME / "profiles" / "other"
    other.mkdir(parents=True, exist_ok=True)
    (other / "config.yaml").write_text("provider_routing:\n  data_collection: deny\n", encoding="utf-8")
    seen = {}

    def runtime(cfg=None, home=None):
        seen["home"] = home
        return {"api_key": "k", "base_url": "https://openrouter.ai/api/v1"}

    def no_key(cfg=None, home=None):
        seen["lookup_home"] = home
        raise RuntimeError("no key")

    saved = api._aai_runtime, api._q_targets, api._q_check_one
    api._aai_runtime, api._q_targets = runtime, lambda home: [("x/m", "P", "p/fp8", False)]
    api._q_check_one = lambda rt, privacy, *a: seen.update(privacy=privacy) or {"answer": "ok"}
    try:
        api._q_run_checks("other", other)
        assert seen["privacy"] == {"data_collection": "deny"}, seen
        assert seen["home"] == other, "the check spends that profile's key"
        api._aai_runtime = no_key
        api._q_lookup_versions(other, [dict(call(NOW, "s", "P"), gen="gen-1")], profile="other")
        assert seen["lookup_home"] == other, "a generation is only readable with the key that made it"
    finally:
        api._aai_runtime, api._q_targets, api._q_check_one = saved


def test_a_skipped_provider_leaves_open_chats_at_their_next_call():
    import types
    spec2 = importlib.util.spec_from_file_location("hermetic_init_q2", HERE.parent / "__init__.py")
    plugin = importlib.util.module_from_spec(spec2)
    spec2.loader.exec_module(plugin)
    cfg = {"provider_routing": {"ignore": ["wafer"], "zdr": True, "models": {"own/m": {"ignore": ["x"]}}}}
    saved = sys.modules.get("hermes_cli.config")
    sys.modules["hermes_cli.config"] = types.SimpleNamespace(load_config_readonly=lambda: cfg)
    plugin._RESYNC_AT[str(HOME)] = time.time()  # no background resync in this test
    try:
        req = {"model": "z-ai/glm-5.3", "messages": [], "extra_body": {"provider": {"ignore": ["novita"]}}}
        out = plugin._on_llm_request(request=req, provider="openrouter", base_url="https://openrouter.ai/api/v1", model="z-ai/glm-5.3", api_request_id="r1")
        assert out["request"]["extra_body"]["provider"]["ignore"] == ["novita", "wafer"], out
        assert out["request"]["extra_body"]["provider"]["zdr"] is True
        own = plugin._on_llm_request(request={"model": "own/m", "messages": []}, provider="openrouter", base_url="", model="own/m", api_request_id="r2")
        assert "ignore" not in own["request"]["extra_body"]["provider"], "a model's own ignore list wins, as in Hermes"
        done = {"model": "z-ai/glm-5.3", "extra_body": {"provider": {"ignore": ["wafer"], "zdr": True}}}
        assert plugin._on_llm_request(request=done, provider="openrouter", base_url="", model="z-ai/glm-5.3", api_request_id="r3") is None
    finally:
        if saved is None:
            sys.modules.pop("hermes_cli.config", None)
        else:
            sys.modules["hermes_cli.config"] = saved


if __name__ == "__main__":
    failed = 0
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            try:
                fn()
                print("ok  ", name)
            except AssertionError as exc:
                failed += 1
                print("FAIL", name, exc)
    shutil.rmtree(HOME, ignore_errors=True)
    sys.exit(1 if failed else 0)
