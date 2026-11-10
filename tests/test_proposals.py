"""A fix for a skill is tried before it is offered: scored best of three beside the skill as it is, within
the budget, and applied only by a person. Model calls are faked, nothing here spends anything.

Run inside Hermes' environment: bash ~/.hermes/hermes-agent/scripts/run-in-hermes-env python3 tests/test_proposals.py
"""
import asyncio
import atexit
import importlib.util
import json
import shutil
import sys
import tempfile
import time
from pathlib import Path


def _tmp():
    """A temporary folder that is removed when the test run ends."""
    d = Path(tempfile.mkdtemp(prefix="hermetic-test-"))
    atexit.register(shutil.rmtree, d, True)
    return d

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("plugin_api", HERE.parent / "dashboard" / "plugin_api.py")
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)

OLD = "---\nname: charts\n---\nDraw the chart.\n"
NEW = "---\nname: charts\n---\nDraw the chart.\nCheck the totals before you answer.\n"
REAL_REPLAY = api._aai_replay_one


def case(i):
    return {"id": f"c{i}", "message_id": str(i), "session_id": "s1", "title": f"chart {i}", "note": "wrong totals", "skill": "charts", "mode": "reply", "ts": i}


def setup(outcome, state=None, spent=0.0, cases=(1, 2, 3)):
    """A profile with one skill and its failing tests. ``outcome(case id, variant label, nth try)`` is the
    judge's verdict for a replay: True, False, None for no verdict, or "error" when it could not run."""
    home = _tmp()
    skill = home / "skills" / "charts" / "SKILL.md"
    skill.parent.mkdir(parents=True)
    skill.write_text(OLD, encoding="utf-8")
    data = api._data_dir(home)
    data.mkdir(parents=True, exist_ok=True)
    (data / "cases.jsonl").write_text("".join(json.dumps(case(i)) + "\n" for i in cases), encoding="utf-8")
    if state:
        (data / "aai-state.json").write_text(json.dumps(state), encoding="utf-8")
    if spent:
        (data / "runs.jsonl").write_text(json.dumps({"ts": time.time(), "label": "earlier today", "cost": spent}) + "\n", encoding="utf-8")
    seen = {"calls": [], "drafted_from": None}
    api._profile_home = lambda profile: ("default", home)
    api._aai_load_cfg = lambda: {}
    api._aai_runtime = lambda cfg=None, home=None: None
    api._aai_provider_obj = lambda cfg, pin=None, fast=False: None
    api._aai_ensure_rubric = lambda home, skill: 0
    api._aai_turn = lambda profile, mid, session_id=None, upto_reply=False, window=None: {
        "user": "make the sales chart number " + str(mid), "reply": "a chart with wrong totals", "session_id": "s1",
        "title": "Charts", "model": "some/model", "system": "", "messages": [], "skills": ["charts"]}

    def helper(model, messages, **kw):
        if messages[0]["content"].startswith("You improve agent skill files"):
            seen["drafted_from"] = messages[1]["content"].count('"why_bad"')
            return {"content": NEW, "cost": 0.03, "finish": "stop"}
        return {"content": json.dumps({"variants": ["chart the sales of another month", "plot last week's sales"]}), "cost": 0.001}

    def replay(home_, profile, cfg, c, variant, judge=False):
        assert judge and variant["trial"], "a trial is always judged and never counts as the test's own result"
        seen["calls"].append((c["id"], variant["label"]))
        v = outcome(c["id"], variant["label"], seen["calls"].count((c["id"], variant["label"])))
        row = {"ts": time.time(), "case_id": c["id"], "label": variant["label"], "trial": True, "cost": 0.01}
        if v == "error":
            row.update(ok=False, error="ProviderError: down", passed=False, cost=0)
        elif v is None:
            row.update(ok=True, checks={"not_empty": True}, passed=True, judge_error="judge gave no verdict")
        else:
            row.update(ok=True, checks={"not_empty": True, "judge": v}, passed=v)
        api._aai_append(api._data_dir(home_) / "runs.jsonl", row)
        return row

    api._aai_helper = helper
    api._aai_replay_one = replay
    return home, skill, seen


def fix_works(cid, label, nth):
    return label == "fix"


def propose(home, **kw):
    return api._aai_propose(None, home, "charts", **kw)


def post(route, payload):
    return asyncio.run(route(payload, profile=None))


def test_a_fix_is_scored_beside_the_skill_as_it_is():
    home, skill, seen = setup(fix_works)
    p = propose(home)
    assert p["ok"] and (p["n"], p["current"], p["fix"]) == (9, 0, 9), p
    assert p["tests"] == ["c1", "c2", "c3"] and sum(1 for r in p["rows"] if r["reworded"]) == 6, "each test and two rewordings of it"
    assert len(seen["calls"]) == 36, "twice each when both replays agree"
    assert p["hint"] and not p["stopped"] and not p["auto"], "an unchecked judge only hints"
    assert p["cost"] == round(0.03 + 3 * 0.001 + 36 * 0.01, 4)
    assert skill.read_text(encoding="utf-8") == OLD, "nothing is applied"
    assert len(api._aai_cases(home)) == 3, "rewordings are not saved as tests"
    assert api._aai_last_runs(home) == {}, "a trial is not a test's own result"
    [waiting] = api._aai_proposals(home)
    assert waiting["id"] == p["id"] and waiting["candidate"].startswith("cand-")


def test_a_third_replay_only_settles_a_disagreement():
    script = {("c1", "fix"): [True, False, True], ("c2", "fix"): [False, True, False]}
    home, _skill, seen = setup(lambda cid, label, nth: script[(cid, label)][nth - 1] if (cid, label) in script else label == "fix")
    p = propose(home)
    assert seen["calls"].count(("c1", "fix")) == seen["calls"].count(("c2", "fix")) == 3
    assert len(seen["calls"]) == 36 + 2, "no third replay where two agreed"
    by = {(r["case"], r["reworded"]): r for r in p["rows"]}
    assert by[("c1", False)]["fix"] and not by[("c2", False)]["fix"], "two of three decide"
    assert p["fix"] == 8 and p["current"] == 0


def test_a_replay_without_a_verdict_is_left_out():
    home, _skill, seen = setup(lambda cid, label, nth: None if (cid, label) == ("c2", "current") else label == "fix")
    p = propose(home)
    assert p["n"] == 8 and all(not (r["case"] == "c2" and not r["reworded"]) for r in p["rows"]), "without the judge any reply would pass"
    assert seen["calls"].count(("c2", "current")) == 3, "asked again in every round"
    home, _skill, _seen = setup(lambda cid, label, nth: "error")
    p = propose(home)
    assert not p["ok"] and p["error"] == "ProviderError: down" and api._aai_proposals(home) == []


def test_the_budget_stops_a_trial():
    home, _skill, seen = setup(fix_works, spent=1.9)
    p = propose(home)
    assert p["ok"] and p["stopped"] and len(seen["calls"]) == 18, "one round fits under four times the daily budget, a second does not"
    home, _skill, seen = setup(fix_works, spent=2.0)
    assert propose(home) == {"ok": False, "error": "Today's replay budget is used up."} and not seen["calls"]
    home, _skill, seen = setup(fix_works, spent=0.5)
    assert not propose(home, auto=True, tests=[case(1)])["ok"], "on its own it stays within the daily budget"


def test_applying_writes_the_fix_and_settles_its_tests():
    home, skill, _seen = setup(lambda cid, label, nth: label == "fix" and cid != "c3")
    p = propose(home)
    done = post(api.aai_ship, {"proposal": p["id"]})
    assert done["ok"] and done["from"] == p["base"] and skill.read_text(encoding="utf-8") == NEW
    assert api._aai_version_text(home, "charts", p["base"]) == OLD, "the earlier version can be restored"
    assert api._aai_proposals(home) == []
    assert [c["id"] for c in api._aai_open_tests(home)] == ["c3"], "tests the fix passed are settled without another replay"
    assert post(api.aai_ship, {"proposal": p["id"]}) == {"ok": False, "error": "This fix is gone. Try a new one."}


def test_a_fix_for_an_older_text_of_the_skill_is_not_applied():
    home, skill, _seen = setup(fix_works)
    p = propose(home)
    assert not asyncio.run(api.aai_proposals(profile=None))["proposals"][0]["stale"]
    skill.write_text(OLD + "Edited by hand.\n", encoding="utf-8")
    assert asyncio.run(api.aai_proposals(profile=None))["proposals"][0]["stale"]
    r = post(api.aai_ship, {"proposal": p["id"]})
    assert not r["ok"] and "changed" in r["error"] and skill.read_text(encoding="utf-8") == OLD + "Edited by hand.\n"


def test_dismissing_closes_a_proposal():
    home, skill, _seen = setup(fix_works)
    p = propose(home)
    assert post(api.aai_proposal_dismiss, {"dismiss": p["id"]}) == {"ok": True}
    assert api._aai_proposals(home) == [] and skill.read_text(encoding="utf-8") == OLD
    assert not post(api.aai_proposal_dismiss, {"dismiss": p["id"]})["ok"]


def test_a_manual_try_fills_up_with_tests_that_pass():
    home, _skill, seen = setup(fix_works)
    api._aai_append(api._data_dir(home) / "runs.jsonl", {"ts": time.time(), "case_id": "c3", "label": "as now", "ok": True, "passed": True, "cost": 0})
    assert api._aai_propose_auto(home, None) is None
    p = propose(home)
    assert p["tests"] == ["c1", "c2", "c3"] and seen["drafted_from"] == 2, "written from the failing ones, tried on all three"


def test_on_its_own_only_when_switched_on_and_for_new_failing_tests():
    home, skill, seen = setup(fix_works)
    assert api._aai_propose_auto(home, None) is None and not seen["calls"], "off unless switched on"
    home, skill, seen = setup(fix_works, state={"auto_propose": "on", "daily_budget": 5})
    p = api._aai_propose_auto(home, None)
    assert p["ok"] and p["auto"] and p["tests"] == ["c1", "c2", "c3"] and skill.read_text(encoding="utf-8") == OLD, "it proposes, it never applies"
    assert api._aai_propose_auto(home, None) is None, "one fix waits for an answer"
    post(api.aai_proposal_dismiss, {"dismiss": p["id"]})
    assert api._aai_propose_auto(home, None) is None, "the same tests are not tried twice"
    for i in (4, 5):
        api._aai_append(api._data_dir(home) / "cases.jsonl", case(i))
    assert api._aai_propose_auto(home, None) is None, "two new failing tests are not enough"
    api._aai_append(api._data_dir(home) / "cases.jsonl", case(6))
    assert api._aai_propose_auto(home, None)["tests"] == ["c4", "c5", "c6"]


def test_on_its_own_a_setup_that_cannot_replay_is_skipped_for_free():
    home, _skill, seen = setup(fix_works, state={"auto_propose": "on"})

    def no_key(cfg=None, home=None):
        raise RuntimeError("no OpenRouter key")
    api._aai_runtime = no_key
    assert api._aai_propose_auto(home, None) is None and not seen["calls"]
    assert api._aai_read(api._data_dir(home) / "proposals.jsonl") == [], "nothing is held against the tests"
    home, _skill, seen = setup(fix_works, state={"auto_propose": "on"}, spent=0.5)
    assert api._aai_propose_auto(home, None) is None and not seen["calls"], "the daily budget is used up"


def test_on_its_own_a_failed_try_is_not_paid_for_again():
    home, _skill, seen = setup(lambda cid, label, nth: "error", state={"auto_propose": "on"})
    assert not api._aai_propose_auto(home, None)["ok"]
    [row] = api._aai_read(api._data_dir(home) / "proposals.jsonl")
    assert row["closed"] == "failed" and row["tests"] == ["c1", "c2", "c3"]
    n = len(seen["calls"])
    assert api._aai_propose_auto(home, None) is None and len(seen["calls"]) == n


def test_one_trial_at_a_time_and_only_for_a_real_skill():
    home, _skill, seen = setup(fix_works)
    api._AAI_PROPOSING[(str(home), "charts")] = time.time()
    try:
        assert propose(home)["error"] == "A fix for this skill is already being tried."
        assert asyncio.run(api.aai_proposals(profile=None))["running"] == ["charts"]
    finally:
        api._AAI_PROPOSING.clear()
    assert not seen["calls"] and (str(home), "charts") not in api._AAI_PROPOSING
    assert api._aai_propose(None, home, "../charts") == api._aai_propose(None, home, "nope") == {"ok": False, "error": "skill not found"}
    est = asyncio.run(api.aai_proposals(profile=None))
    assert est["running"] == [] and 0.3 < est["estimate"] < 0.6 and est["at"] == 3


def test_a_trial_replay_is_marked_and_does_not_stand_for_the_test():
    home, _skill, _seen = setup(fix_works)
    api._aai_tool_defs = lambda: []
    api._aai_call = lambda model, msgs, **kw: {"content": "a chart", "tool_calls": [], "finish": "stop", "provider": "p", "cost": 0.01, "secs": 1,
                                                 "id": "g", "input": 1, "output": 1}
    api._aai_judge_plan = lambda home, cfg, st, c, request, res, calls: ("pass", 0.001)
    row = REAL_REPLAY(home, None, {}, case(1), {"label": "fix", "skill_name": "charts", "skill_text": NEW, "version": "cand-0123456789", "trial": True}, judge=True)
    assert row["ok"] and row["trial"] and row["checks"]["judge"] and row["window"] == "small", row
    assert api._aai_last_runs(home) == {} and [c["id"] for c in api._aai_open_tests(home)] == ["c1", "c2", "c3"]
    REAL_REPLAY(home, None, {}, case(1), {"label": "as now"}, judge=True)
    assert [c["id"] for c in api._aai_open_tests(home)] == ["c2", "c3"], "its own replay does"


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
