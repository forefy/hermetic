"""The AAI judge: calibration against the user's stars and corrections, and an untrusted judge never deciding a revert.

Run inside Hermes' environment: bash ~/.hermes/hermes-agent/scripts/run-in-hermes-env python3 tests/test_judge.py
"""
import importlib.util
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("plugin_api", HERE.parent / "dashboard" / "plugin_api.py")
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)


def test_families():
    assert api._aai_family("deepseek/deepseek-v4.1-flash") == api._aai_family("deepseek-v4") == "deepseek"
    assert api._aai_family("anthropic/claude-opus-5") == api._aai_family("claude-sonnet-5-5") == "anthropic"
    assert api._aai_family("z-ai/glm-5.3") == "z-ai" and api._aai_family("openai/gpt-5.2") == "openai"
    assert api._aai_family("openai/o3-mini") == "openai" and api._aai_family("z-ai/glm-5.3") != "openai", "o3 only as a name prefix"
    assert api._aai_family("") is None


def test_judge_runs_on_the_main_model_unless_allowed():
    st = {"judge_model": "deepseek/deepseek-v4.1-flash"}
    main = {"model": {"default": "z-ai/glm-5.3"}}
    assert api._aai_judge_runs_on(main, st) == "z-ai/glm-5.3"
    allow = lambda llm: dict(main, plugins={"entries": {"hermetic": {"llm": llm}}})
    assert api._aai_judge_runs_on(allow({"allow_model_override": True}), st) == st["judge_model"]
    assert api._aai_judge_runs_on(allow({"allow_model_override": True, "allowed_models": ["*"]}), st) == st["judge_model"]
    assert api._aai_judge_runs_on(allow({"allow_model_override": True, "allowed_models": ["DeepSeek/DeepSeek-v4.1-Flash"]}), st) == st["judge_model"]
    assert api._aai_judge_runs_on(allow({"allow_model_override": True, "allowed_models": ["openai/gpt-5"]}), st) == "z-ai/glm-5.3"
    assert api._aai_judge_runs_on(allow({"allowed_models": ["*"]}), st) == "z-ai/glm-5.3", "no override flag"


def test_calibration_keeps_every_low_rating():
    ratings = [{"message_id": f"g{i}", "score": 5} for i in range(60)] + [{"message_id": f"b{i}", "score": 1} for i in range(6)]
    items = api._aai_calibration_items(ratings)
    assert len(items) == 40 and sum(1 for r in items if r["score"] <= 2) == 6
    assert items[-1]["message_id"] == "g59", "the good ones are the most recent"
    rerated = [{"message_id": "x", "score": 5}, {"message_id": "x", "score": 1}]
    assert [r["score"] for r in api._aai_calibration_items(rerated)] == [1], "latest rating wins"


def test_three_stars_are_not_agreement():
    pairs = [(5, 1), (1, 0), (3, 1), (3, 0), (4, 0)]
    assert api._aai_agreement(pairs) == (2, 3)


def test_trust_needs_corrected_replies_failed():
    assert api._aai_trusted(0.6, 20, 5, 0, 0), "too few corrections to require them"
    assert api._aai_trusted(0.6, 20, 5, 4, 5)
    assert not api._aai_trusted(0.6, 20, 5, 2, 5), "passes polished wrong answers"
    assert not api._aai_trusted(0.6, 20, 4, 5, 5) and not api._aai_trusted(0.4, 30, 9, 5, 5) and not api._aai_trusted(None, 30, 9, 5, 5)


def test_trust_follows_the_model_that_was_checked():
    cfg = {"model": {"default": "z-ai/glm-5.3"}}
    st = {"judge_model": "deepseek/deepseek-v4.1-flash", "judge_trust": {"trusted": True, "models": ["z-ai/glm-5.3"]}}
    assert api._aai_judge_trusted(cfg, st)
    assert not api._aai_judge_trusted({"model": {"default": "anthropic/claude-opus-5"}}, st), "main model changed since the check"
    assert not api._aai_judge_trusted(cfg, dict(st, judge_trust={"trusted": False, "models": ["z-ai/glm-5.3"]}))
    assert not api._aai_judge_trusted(cfg, {"judge_model": "x/y"})


def _gate(trusted):
    """One skill change, two tests; the judge fails both after the change, every other check passes."""
    tmp = Path(tempfile.mkdtemp())
    skill_file = tmp / "SKILL.md"
    skill_file.write_text("new", encoding="utf-8")
    state = {"gate_mode": "revert", "daily_budget": 0.5, "judge_model": "deepseek/deepseek-v4.1-flash", "last_ledger_ts": 1.0,
             "judge_trust": {"trusted": trusted, "models": ["z-ai/glm-5.3"]}}
    rows = [{"label": lbl, "case_id": c, "ok": True, "checks": {"not_empty": True, "judge": lbl == "before"}, "passed": lbl == "before"}
            for lbl in ("before", "after") for c in ("c1", "c2")]
    api._aai_state = lambda home: dict(state)
    api._aai_save_state = lambda home, st: None
    api._aai_ledger = lambda home: [{"ts": "2026-10-26T10:00:00Z", "skill": "s", "actor": "review", "before": [{"path": "s/SKILL.md", "sha256": "a" * 64}]}]
    api._aai_snapshot_versions = lambda home, ledger: None
    api._aai_cases = lambda home: [{"id": "c1", "skill": "s"}, {"id": "c2", "skill": "s"}]
    api._aai_version_text = lambda home, skill, sha: "old" if sha != "current" else "new"
    api._aai_spent_today = lambda home: 0.0
    api._aai_run_matrix = lambda home, profile, cases, variants: [dict(r) for r in rows]
    api._aai_skill_path = lambda home, skill: skill_file
    api._aai_append = lambda path, row: None
    api._aai_load_cfg = lambda: {"model": {"default": "z-ai/glm-5.3"}}
    [dec] = api._aai_gate_once(tmp, None)
    return dec, skill_file.read_text(encoding="utf-8")


def test_an_untrusted_judge_does_not_revert():
    dec, text = _gate(trusted=False)
    assert dec["judge"] == "ignored, not trusted yet" and dec["verdict"] == "kept" and text == "new", dec


def test_a_trusted_judge_can_revert():
    dec, text = _gate(trusted=True)
    assert dec["judge"] == "counted" and dec["action"] == "reverted" and text == "old", dec


def test_check_route_counts_corrections_and_saves_trust():
    """A judge that likes everything agrees with good stars but passes the corrected replies: not trusted."""
    import asyncio
    import json
    tmp = Path(tempfile.mkdtemp())
    saved = {}
    ratings = [{"message_id": f"g{i}", "value": "good", "score": 5} for i in range(16)] + [{"message_id": f"b{i}", "value": "bad", "score": 1} for i in range(6)]
    api._profile_home = lambda profile: ("p", tmp)
    api._aai_state = lambda home: {"judge_model": "deepseek/deepseek-v4.1-flash"}
    api._aai_save_state = lambda home, st: saved.update(st)
    api._aai_load_cfg = lambda: {"model": {"default": "deepseek/deepseek-v4"}}
    api._aai_read = lambda path: ratings if path.name == "ratings.jsonl" else []
    api._aai_cases = lambda home: [{"id": f"c{i}", "message_id": f"b{i}", "mode": "reply", "note": "wrong facts"} for i in range(4)]
    api._aai_append = lambda path, row: None
    api._aai_provider_obj = lambda cfg, pin=None, fast=False: None
    api._aai_turn = lambda profile, mid, session_id=None, upto_reply=False: {"user": "q " + mid, "reply": "a polished answer"}
    seen = []
    def helper(model, messages, **kw):
        seen.append(messages[0]["content"][:30])
        mid = messages[-1]["content"].split("q ")[1].split()[0]
        verdict = "fail" if mid.startswith("b") and "corrected by its user" not in messages[0]["content"] else "pass"
        return {"content": json.dumps({"verdict": verdict}), "cost": 0.0001, "model": "deepseek/deepseek-v4"}
    api._aai_helper = helper
    r = asyncio.run(api.aai_judge({}, profile=None))
    assert r["n"] == 22 and r["agree"] == 22 and r["decided"] == 22 and r["bad"] == 6, r
    assert r["corrected"] == 4 and r["caught"] == 0 and not r["trusted"] and r["same_family"], r
    assert saved["judge_trust"] == {"ts": r["ts"], "trusted": False, "models": ["deepseek/deepseek-v4"]}
    assert sum(1 for x in seen if x.startswith("An AI assistant's earlier")) == 4, "corrections use the grading prompt"


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
    sys.exit(1 if failed else 0)
