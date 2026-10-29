"""AAI finds the replies you pushed back on, in compacted turns too, and offers them for rating first.

Run inside Hermes' environment: bash ~/.hermes/hermes-agent/scripts/run-in-hermes-env python3 tests/test_frustration.py
"""
import asyncio
import importlib.util
import json
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("plugin_api", HERE.parent / "dashboard" / "plugin_api.py")
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)

NOW = time.time()
# ids 1 to 3 were compacted away: only a read of the conversation as shown still has them
COMPACTED = [{"id": 1, "role": "user", "content": "make the chart", "timestamp": NOW - 900},
             {"id": 2, "role": "assistant", "content": "done, here it is", "timestamp": NOW - 890},
             {"id": 3, "role": "user", "content": "[The user attached an image: a.png] wtf the chart is still broken??", "timestamp": NOW - 800}]
ACTIVE = [{"id": 4, "role": "assistant", "content": "fixed it", "timestamp": NOW - 790},
          {"id": 5, "role": "user", "content": "great, now add a legend", "timestamp": NOW - 700},
          {"id": 6, "role": "assistant", "content": "added the legend", "timestamp": NOW - 690},
          {"id": 7, "role": "user", "content": '[Cronjob "nightly" output] all good', "timestamp": NOW - 600},
          {"id": 9, "role": "user", "content": "[IMPORTANT: Background process proc_1 completed] exit 0", "timestamp": NOW - 595},
          {"id": 8, "role": "assistant", "content": "summary of the run", "timestamp": NOW - 590}]
ROW = {"id": "s1", "title": "Charts", "last_active": NOW - 590, "message_count": 9, "api_call_count": 4}


class FakeDb:
    def get_messages(self, session_id, include_inactive=False, include_compacted=False, **kw):
        return COMPACTED + ACTIVE if include_compacted else list(ACTIVE)

    def list_sessions_rich(self, **kw):
        return [ROW]

    def close(self):
        pass


def use_fake(home):
    api._open_sessions_db = lambda profile: FakeDb()
    api._sessions_store = lambda profile: "fake-store-" + str(home)
    api._profile_home = lambda profile: ("default", home)


def test_what_counts_as_pushing_back():
    for text in ["wtf? @image:`/tmp/x.png`", "come on like WTF why is this still here????",
                 "DO IT DONT STOP UNTIL ALL ARE VALIDATED AND PERFECT!!!", "what are these why broken images",
                 "you forgot the tests", "No, generate with actual screenshots", "still not submitted packages?",
                 "it doesn't work", "[The user attached an image: a.png] wtf", "You're a bit slow, let me help"]:
        assert api._aai_frustrated(text), text
    for text in ["So that means PoC still works?", "is it still running?", "great, now add a legend", "unset ???",
                 "[The user attached an image: no.png] thanks"]:
        assert not api._aai_frustrated(text), text


def test_compacted_turns_are_read():
    db = FakeDb()
    assert len(api._db_messages(db, "s1")) == 6 and len(api._db_messages(db, "s1", shown=True)) == 9
    sid, msgs = api._aai_find_message(db, 2, "s1")
    assert sid == "s1" and any(m["id"] == 2 for m in msgs), "a compacted reply can still be kept as a test"


def test_corrections_include_compacted_ones():
    use_fake(Path(tempfile.mkdtemp()))
    items = asyncio.run(api.aai_corrections(days=14, profile=None))["items"]
    assert [(x["message_id"], x["correction_id"]) for x in items] == [("2", "3")]
    assert items[0]["text"] == "wtf the chart is still broken??", "what Hermes added in front is left out"


def test_rate_queue_puts_pushback_first_then_takes_turns():
    home = Path(tempfile.mkdtemp())
    use_fake(home)
    items = asyncio.run(api.aai_rate_queue(n=5, profile=None))["items"]
    assert [x["message_id"] for x in items] == ["2", "4", "8"], "pushed back on, moved on from, then no answer yet"
    assert items[0]["frustrated"] and items[0]["followup"] == "wtf the chart is still broken??"
    assert not items[1]["frustrated"] and items[1]["followup"] == "great, now add a legend"
    assert items[2]["followup"] is None, "scheduled job output and Hermes' own notes are not your answer"
    api._data_dir(home).mkdir(parents=True, exist_ok=True)
    (api._data_dir(home) / "ratings.jsonl").write_text(json.dumps({"message_id": "2", "score": 1}) + "\n")
    items = asyncio.run(api.aai_rate_queue(n=5, profile=None))["items"]
    assert [x["message_id"] for x in items] == ["4", "8"], "a rated reply leaves the queue"


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
