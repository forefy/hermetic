"""Per-session extracts are reused until the session changes, so HDR and AAI only re-read new chats.

Run inside Hermes' environment: bash ~/.hermes/hermes-agent/scripts/run-in-hermes-env python3 tests/test_session_cache.py
"""
import importlib.util
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("plugin_api", HERE.parent / "dashboard" / "plugin_api.py")
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)


class FakeDb:
    """Stands in for SessionDB: counts how often a session's messages are read."""

    def __init__(self):
        self.reads = 0
        self.messages = [{"id": 1, "role": "user", "content": "hi", "timestamp": 10.0},
                         {"id": 2, "role": "assistant", "content": "", "timestamp": 11.0,
                          "tool_calls": [{"function": {"name": "skill_view", "arguments": '{"name": "notes"}'}}]}]

    def get_messages(self, session_id, **kw):
        self.reads += 1
        return list(self.messages)


ROW = {"id": "s1", "last_active": 11.0, "message_count": 2, "api_call_count": 1}


def test_an_unchanged_session_is_read_once():
    db = FakeDb()
    a = api._per_session(db, "store-a", ROW, "turns", api._session_turns)
    b = api._per_session(db, "store-a", ROW, "turns", api._session_turns)
    assert a == b and db.reads == 1
    assert a[1][4] == ["notes"], "skills the reply loaded"


def test_a_new_message_is_picked_up():
    db = FakeDb()
    api._per_session(db, "store-b", ROW, "calls", api._session_calls, every=True)
    db.messages.append({"id": 3, "role": "assistant", "content": "", "timestamp": 12.0,
                        "tool_calls": [{"function": {"name": "terminal", "arguments": '{"command": "cat ~/.ssh/config"}'}}]})
    row = dict(ROW, last_active=12.0, message_count=3)
    calls = api._per_session(db, "store-b", row, "calls", api._session_calls, every=True)
    assert db.reads == 2 and [c[1] for c in calls] == ["skill_view", "terminal"]
    assert calls[1][3][0] == [("~/.ssh/config", "read")], "touched paths are kept with the call"


def test_profiles_do_not_share_entries():
    db = FakeDb()
    api._per_session(db, "store-c", ROW, "turns", api._session_turns)
    api._per_session(db, "store-d", ROW, "turns", api._session_turns)
    assert db.reads == 2


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
