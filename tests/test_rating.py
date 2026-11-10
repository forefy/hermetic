"""Rating a reply: one step saves the stars and, for a low one, its test, and a replay reads a small window.

Run inside Hermes' environment: bash ~/.hermes/hermes-agent/scripts/run-in-hermes-env python3 tests/test_rating.py
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

NOW = time.time()
LONG = "The legend sits under the chart. " * 20
MSGS = [{"id": 1, "role": "user", "content": "make the chart for the weekly report", "timestamp": NOW - 900},
        {"id": 2, "role": "assistant", "content": "## Done\n\nHere is the [chart](https://example.com/c.png) with **bold** totals and `code`.", "timestamp": NOW - 890},
        {"id": 3, "role": "user", "content": "wtf the chart is still broken??", "timestamp": NOW - 800},
        {"id": 4, "role": "assistant", "content": "fixed it", "timestamp": NOW - 790},
        {"id": 5, "role": "user", "content": "great, now add a legend", "timestamp": NOW - 700},
        {"id": 6, "role": "assistant", "content": LONG, "timestamp": NOW - 690}]
ROW = {"id": "s1", "title": "Charts", "last_active": NOW - 690, "message_count": 6, "api_call_count": 3}


class FakeDb:
    def get_messages(self, session_id, include_inactive=False, include_compacted=False, **kw):
        return list(MSGS)

    def list_sessions_rich(self, **kw):
        return [ROW]

    def get_session(self, session_id):
        return dict(ROW, model="some/model")

    def close(self):
        pass


def fresh():
    home = _tmp()
    api._open_sessions_db = lambda profile: FakeDb()
    api._sessions_store = lambda profile: "fake-store-" + str(home)
    api._profile_home = lambda profile: ("default", home)
    return home


def rate(**payload):
    return asyncio.run(api.aai_rate(payload, profile=None))


def queue(**kw):
    return asyncio.run(api.aai_rate_queue(n=5, profile=None, **kw))


def test_queue_shows_what_you_asked_and_a_clean_preview():
    fresh()
    q = queue()
    first = q["items"][0]
    assert first["message_id"] == "2" and first["request"] == "make the chart for the weekly report"
    assert first["preview"] == "Done Here is the chart with bold totals and code.", first["preview"]
    assert not first["cut"] and next(x for x in q["items"] if x["message_id"] == "6")["cut"], "a preview that was shortened says so"
    assert q["left"] == 3 and q["ratings"] == {"total": 0, "low": 0, "bad": 0, "okay": 0, "good": 0}


def test_first_puts_one_reply_in_front():
    fresh()
    assert queue(first="6")["items"][0]["message_id"] == "6"
    assert queue(first="nope")["items"][0]["message_id"] == "2", "an unknown reply changes nothing"


def test_skipped_replies_stay_out_until_asked_for():
    fresh()
    q = queue(skip="2,4")
    assert [x["message_id"] for x in q["items"]] == ["6"] and q["left"] == 1
    assert queue(skip="2,4", first="4")["items"][0]["message_id"] == "4", "asked for by name, it comes back"
    assert len(queue(skip=",,nope")["items"]) == 3


def test_a_low_rating_with_a_reason_becomes_one_test():
    home = fresh()
    r = rate(message_id="2", session_id="s1", score=2, reasons=["wrong facts"], note="totals are off", test=True)
    assert r["ok"] and r["case_new"] and r["ratings"]["total"] == 1 and r["ratings"]["low"] == 1, r
    [case] = api._aai_cases(home)
    assert case["id"] == r["case_id"] and case["mode"] == "reply" and case["source"] == "rating"
    assert case["note"] == "wrong facts. totals are off" and case["title"] == "make the chart for the weekly report", "named after the request"
    again = asyncio.run(api.aai_case_add({"message_id": "2", "note": "x", "mode": "reply"}, profile=None))
    assert again["existing"] and again["case"]["id"] == case["id"], "the same reply is never two tests"
    r2 = rate(message_id="2", session_id="s1", score=1, reasons=["unsafe"], test=True)
    assert r2["case_id"] == case["id"] and not r2["case_new"] and r2["ratings"]["total"] == 1, "rated again, still one rating and one test"
    assert len(api._aai_cases(home)) == 1 and [x["message_id"] for x in queue()["items"]] == ["4", "6"]


def test_a_test_needs_something_to_check_against():
    home = fresh()
    assert rate(message_id="4", score=3, test=True)["case_id"] is None, "no reason, note or answer: nothing to check a replay against"
    assert rate(message_id="6", score=5, reasons=["too long"], test=True)["case_id"] is None, "a good reply is not a test"
    r = rate(message_id="2", score=2, test=True, followup="wtf the chart is still broken??")
    assert r["case_id"] and api._aai_cases(home)[0]["note"] == "wtf the chart is still broken??", "what you said next is the complaint"
    assert rate(score=1) == {"ok": False, "error": "No reply to rate."}
    assert not rate(message_id="2", score=9)["ok"]


def test_undo_takes_back_the_rating_and_the_test_it_made():
    home = fresh()
    r = rate(message_id="2", score=1, reasons=["wrong facts"], test=True)
    u = rate(message_id="2", undo=True, case_id=r["case_id"])
    assert u["ok"] and u["ratings"]["total"] == 0 and api._aai_cases(home) == []
    assert queue()["items"][0]["message_id"] == "2", "the reply can be rated again"
    kept = asyncio.run(api.aai_case_add({"message_id": "4", "note": "kept by hand", "mode": "reply"}, profile=None))["case"]
    rate(message_id="4", score=2, reasons=["wrong tool"], test=True)
    rate(message_id="4", undo=True, case_id=kept["id"])
    assert [c["id"] for c in api._aai_cases(home)] == [kept["id"]], "a test made another way is not removed"


def test_corrections_leave_out_replies_already_handled():
    fresh()
    corrections = lambda: [x["message_id"] for x in asyncio.run(api.aai_corrections(days=14, profile=None))["items"]]
    assert corrections() == ["2"]
    r = rate(message_id="2", score=4)
    assert corrections() == [], "rated"
    rate(message_id="2", undo=True, case_id=r["case_id"])
    asyncio.run(api.aai_case_add({"message_id": "2", "note": "x", "mode": "reply"}, profile=None))
    assert corrections() == [], "already a test"


def _chat(turns, tool_chars):
    """A chat of ``turns`` requests, each answered through one tool call with a long result."""
    msgs = []
    for i in range(turns):
        call = {"id": f"call{i}", "type": "function", "function": {"name": "write_file", "arguments": json.dumps({"path": "a.txt", "content": "w" * tool_chars})}}
        msgs += [{"role": "user", "content": f"request {i} " + "r" * 300},
                 {"role": "assistant", "content": "", "tool_calls": [call]},
                 {"role": "tool", "tool_call_id": f"call{i}", "content": "t" * tool_chars},
                 {"role": "assistant", "content": f"answer {i}"}]
    return msgs[:-1]  # the last reply is the one being replayed


def test_small_window_keeps_the_request_and_fits():
    msgs = _chat(8, 30_000)
    out = api._aai_small_window(msgs)
    assert api._aai_msgs_size(out) <= api._AAI_WINDOW_CHARS < api._aai_msgs_size(msgs)
    assert out[0]["role"] == "user" and len([m for m in out if m["role"] == "user"]) <= api._AAI_WINDOW_TURNS
    last = [m for m in out if m["role"] == "user"][-1]
    assert last["content"] == msgs[-3]["content"], "the request being replayed is never shortened"
    calls = {t["id"] for m in out for t in m.get("tool_calls", [])}
    assert calls == {m["tool_call_id"] for m in out if m["role"] == "tool"}, "every tool call still has its result"
    for m in out:
        for t in m.get("tool_calls", []):
            json.loads(t["function"]["arguments"])
    short = _chat(2, 50)
    assert api._aai_small_window(short) == short, "a short chat is left as it is"
    assert api._aai_small_window([{"role": "assistant", "content": "hi"}]) == [{"role": "assistant", "content": "hi"}]


def test_small_window_never_drops_the_replayed_turn():
    msgs = [{"role": "user", "content": "old"}, {"role": "assistant", "content": "ok"},
            {"role": "user", "content": "q" * 60_000}]
    out = api._aai_small_window(msgs)
    assert out == [msgs[-1]], "a request longer than the window is still sent whole"


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
