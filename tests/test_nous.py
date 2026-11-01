"""Nous Portal: what it billed per call is recorded, compared with its list prices, and its credits reach the popover.
The privacy rules reach main and background calls on the Portal, and nothing else it would refuse.

Run inside Hermes' environment: bash ~/.hermes/hermes-agent/scripts/run-in-hermes-env python3 tests/test_nous.py
"""
import asyncio
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import types
from pathlib import Path

HERE = Path(__file__).resolve().parent
HOME = Path(tempfile.mkdtemp(prefix="hermetic-nous-test-"))
os.environ["HERMES_HOME"] = str(HOME)  # a throwaway profile, never the real one

spec = importlib.util.spec_from_file_location("hermetic_init", HERE.parent / "__init__.py")
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)
spec = importlib.util.spec_from_file_location("plugin_api", HERE.parent / "dashboard" / "plugin_api.py")
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)
api._profile_home = lambda profile: ("default", HOME)

BILLS = HOME / "hermetic" / "nous-billed.jsonl"
PRICES = {"x/m": {"prompt": "0.000001", "completion": "0.000004", "input_cache_read": "0.0000001"}}
sys.modules["hermes_cli.models_pricing"] = types.SimpleNamespace(get_pricing_for_provider=lambda p, **k: PRICES if p == "nous" else {})


class Usage:
    """Like the OpenAI SDK's usage object: the Portal's own fields sit in model_extra."""
    prompt_tokens, completion_tokens = 1000, 100
    prompt_tokens_details = types.SimpleNamespace(cached_tokens=400)

    def __init__(self, cost, floor=False):
        self.model_extra = {"cost": cost, "cost_details": {"floor_applied": floor}}


def call(result, provider="nous", base_url="https://inference-api.nousresearch.com/v1"):
    return plugin._on_llm_execution(next_call=lambda req: result, request={}, api_request_id="r1", session_id="s1",
                                    provider=provider, base_url=base_url, model="x/m")


def rows():
    return [json.loads(l) for l in BILLS.read_text().splitlines()] if BILLS.exists() else []


def test_what_nous_billed_is_recorded_per_call():
    BILLS.unlink(missing_ok=True)
    result = types.SimpleNamespace(model="x/m", usage=Usage(0.00105))
    assert call(result) is result, "the call's result passes through untouched"
    r = rows()[-1]
    assert (r["model"], r["billed"], r["floor"], r["input"], r["output"], r["cache"], r["session"]) == ("x/m", 0.00105, 0, 1000, 100, 400, "s1")
    call(types.SimpleNamespace(model="x/m", usage={"prompt_tokens": 10, "completion_tokens": 1, "cost": 0.0001, "cost_details": {"floor_applied": True}}))
    assert rows()[-1]["floor"] == 1 and rows()[-1]["billed"] == 0.0001, "a plain dict usage works too"


def test_nothing_is_recorded_without_a_cost_or_off_nous():
    BILLS.unlink(missing_ok=True)
    call(types.SimpleNamespace(model="x/m", usage=types.SimpleNamespace(prompt_tokens=5, completion_tokens=1)))
    call(types.SimpleNamespace(model="x/m", usage=Usage(0.5)), provider="openrouter", base_url="https://openrouter.ai/api/v1")
    call(types.SimpleNamespace(model="x/m"))
    assert rows() == []


def test_billed_is_compared_with_list_prices_per_day():
    BILLS.unlink(missing_ok=True)
    call(types.SimpleNamespace(model="x/m", usage=Usage(0.00104)))
    call(types.SimpleNamespace(model="x/m", usage=Usage(0.002, floor=True)))
    call(types.SimpleNamespace(model="unpriced/m", usage=Usage(0.3)))
    days = asyncio.run(api.nous_billed(days=30, profile=None))["days"]
    d = days[time.strftime("%Y-%m-%d")]
    listed = 600e-6 + 400e-7 + 100 * 4e-6
    assert d["calls"] == 2 and d["floors"] == 1, "a model without a list price is left out"
    assert abs(d["billed"] - 0.00304) < 1e-12 and abs(d["list"] - 2 * listed) < 1e-12


def test_usable_credits_reach_the_popover_as_a_number():
    snap = types.SimpleNamespace(title="Nous credits", plan=None, details=["Total usable: $0.40"], unavailable_reason=None, windows=[])
    f = api._snapshot_fields(snap, {"window": None, "credits": 0.4})
    assert f["credits"] == 0.4 and f["windows"] == []
    assert api._snapshot_fields(snap)["credits"] is None, "other providers have no credits field"


class Config:
    """Hermes' config, in memory: what load_config returns and save_config writes."""
    def __init__(self, cfg):
        self.cfg, self.saves = cfg, 0

    def __enter__(self):
        self.saved = {k: sys.modules.get(k) for k in ("hermes_cli.config", "hermes_cli.config_defaults")}
        sys.modules["hermes_cli.config"] = types.SimpleNamespace(
            load_config=lambda: json.loads(json.dumps(self.cfg)), load_config_readonly=lambda: self.cfg, save_config=self._save)
        sys.modules["hermes_cli.config_defaults"] = types.SimpleNamespace(
            DEFAULT_CONFIG={"auxiliary": {"title_generation": {}, "compression": {}, "web_extract": {}, "moa_reference": {}}})
        (HOME / "hermetic" / "aux-routing.json").unlink(missing_ok=True)
        return self

    def _save(self, cfg):
        self.cfg, self.saves = cfg, self.saves + 1

    def __exit__(self, *a):
        for k, v in self.saved.items():
            if v is None:
                sys.modules.pop(k, None)
            else:
                sys.modules[k] = v

    def provider(self, task):
        return ((self.cfg.get("auxiliary") or {}).get(task) or {}).get("extra_body", {}).get("provider")


RULES = {"data_collection": "deny", "zdr": True, "sort": "price", "ignore": ["a"]}
ON_NOUS = {"provider": "nous", "base_url": "https://inference-api.nousresearch.com/v1"}
ON_OPENROUTER = {"provider": "openrouter", "base_url": "https://openrouter.ai/api/v1"}


def test_each_background_task_gets_what_its_provider_takes():
    assert api._task_route({}, ON_NOUS) == "nous" and api._task_route({"provider": "main"}, ON_OPENROUTER) == "openrouter"
    assert api._task_route({"provider": "auto", "base_url": "https://openrouter.ai/api/v1"}, ON_NOUS) == "openrouter", "a task's own address wins"
    assert api._task_route({"provider": "anthropic"}, ON_OPENROUTER) is None
    assert api._routing_for("nous", RULES) == {"data_collection": "deny", "zdr": True}
    assert api._routing_for("openrouter", RULES) == RULES and api._routing_for(None, RULES) == {}
    cfg = {"model": dict(ON_NOUS), "provider_routing": dict(RULES),
           "auxiliary": {"web_extract": {"provider": "openrouter"}, "compression": {"provider": "anthropic"}}}
    with Config(cfg) as c:
        out = api._aux_apply(True)
        assert c.provider("title_generation") == {"data_collection": "deny", "zdr": True}, "a task following main on Nous gets only the privacy rules"
        assert c.provider("web_extract")["sort"] == "price", "a task pinned to OpenRouter gets all the rules"
        assert c.provider("compression") is None and c.provider("moa_reference") is None
        assert sorted(out["written"]) == ["title_generation", "web_extract"] and out["stale"] == out["out_of_sync"] == []
        assert all(set(t) == {"task", "route", "openrouter", "managed", "has_routing", "in_sync"} for t in out["tasks"])
        saves = c.saves
        api._aux_apply(True)
        assert c.saves == saves, "nothing is written when nothing changed"


def test_switching_main_provider_resyncs_only_managed_tasks():
    cfg = {"model": dict(ON_OPENROUTER), "provider_routing": dict(RULES), "auxiliary": {}}
    with Config(cfg) as c:
        assert api.aux_resync() is None, "does nothing while mirroring is off"
        api._aux_apply(True)
        assert c.provider("title_generation")["sort"] == "price"
        c.cfg["model"] = dict(ON_NOUS)
        c.cfg["auxiliary"]["web_extract"]["extra_body"] = {"provider": {"sort": "latency"}}
        state = json.loads((HOME / "hermetic" / "aux-routing.json").read_text())
        state["managed"].remove("web_extract")
        (HOME / "hermetic" / "aux-routing.json").write_text(json.dumps(state))
        st = api._aux_status(c.cfg)
        assert sorted(st["out_of_sync"]) == ["compression", "title_generation"] and st["stale"] == []
        api.aux_resync()
        assert c.provider("title_generation") == {"data_collection": "deny", "zdr": True}, "OpenRouter's fields leave a task now on Nous"
        assert c.provider("web_extract") == {"sort": "latency"}, "a task this plugin does not manage is left alone"
        assert api.aux_resync() is None, "nothing to do once in step"
        c.cfg["provider_routing"] = {"sort": "price"}
        api.aux_resync()
        assert c.provider("title_generation") is None, "with no privacy rules a task on Nous gets no provider object"
        assert api._aux_status(c.cfg)["stale"] == []


def _request(model="x/m"):
    return {"model": model, "messages": [], "extra_body": {"tags": ["product=hermes-agent"]}}


def test_main_calls_on_nous_carry_the_privacy_rules():
    plugin._RESYNC_AT[str(HOME)] = time.time()  # no background re-sync during these calls
    cfg = {"provider_routing": {"data_collection": "deny", "zdr": True, "sort": "price", "only": ["a"],
                                "models": {"x/strict": {"zdr": False}}}}
    with Config(cfg):
        out = plugin._on_llm_request(request=_request(), provider="nous", base_url=ON_NOUS["base_url"], model="x/m", api_request_id="r1")
        assert out["request"]["extra_body"] == {"tags": ["product=hermes-agent"], "provider": {"data_collection": "deny", "zdr": True}}
        assert out["reason"] == "privacy rules for Nous Portal: data_collection, zdr"
        strict = plugin._on_llm_request(request=_request("x/strict"), provider="nous", base_url="", model="x/strict", api_request_id="r2")
        assert strict["request"]["extra_body"]["provider"]["zdr"] is False, "a per-model rule wins"
    with Config({"provider_routing": {"sort": "price"}}):
        assert plugin._on_llm_request(request=_request(), provider="nous", base_url="", model="x/m", api_request_id="r3") is None


def test_the_background_resync_runs_at_most_once_a_minute():
    ran = threading.Event()
    calls = []
    saved = plugin._resync_aux
    plugin._resync_aux = lambda: (calls.append(1), ran.set())
    try:
        plugin._RESYNC_AT.pop(str(HOME), None)
        plugin._maybe_resync_aux()
        assert ran.wait(5)
        plugin._maybe_resync_aux()
        time.sleep(0.2)
        assert calls == [1]
    finally:
        plugin._resync_aux = saved


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
