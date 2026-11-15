"""Costs reads reply days and tool output sizes without loading message text, and gets what a full read gets.

Run inside Hermes' environment: bash ~/.hermes/hermes-agent/scripts/run-in-hermes-env python3 tests/test_quick_reads.py
"""
import importlib.util
import shutil
import sqlite3
import sys
import tempfile
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("plugin_api", HERE.parent / "dashboard" / "plugin_api.py")
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)

DAY = 86400
NOON = time.mktime(time.strptime(time.strftime("%Y-%m-%d"), "%Y-%m-%d")) + 12 * 3600  # today, local noon
day_of = lambda ts: time.strftime("%Y-%m-%d", time.localtime(ts))


def real_store():
    """A real Hermes session store with one chat over two days: a big tool result early on, 30 tool
    rounds after it, and the leftovers a compaction and a rewind make (a second copy of a reply)."""
    from hermes_state import SessionDB
    folder = Path(tempfile.mkdtemp(prefix="hermetic-quick-"))
    path = folder / "state.db"
    db = SessionDB(db_path=path)
    db.create_session("chat", "desktop", model="z-ai/glm-5.3")
    msgs = [{"role": "user", "content": "go", "timestamp": NOON - DAY}]
    for i in range(31):
        ts = NOON - DAY + 10 * i if i < 12 else NOON + 10 * i
        call = "call_%d" % i
        msgs.append({"role": "assistant", "content": "", "timestamp": ts,
                     "tool_calls": [{"id": call, "type": "function", "function": {"name": "terminal", "arguments": "{}"}}]})
        msgs.append({"role": "tool", "content": "x" * (40_000 if i == 0 else 300), "tool_call_id": call, "tool_name": "terminal", "timestamp": ts + 1})
    db.append_messages_batch("chat", msgs)
    db.close()
    raw = sqlite3.connect(path)
    reply = raw.execute("SELECT id FROM messages WHERE role = 'assistant' ORDER BY id LIMIT 1").fetchone()[0]
    columns = [c[1] for c in raw.execute("PRAGMA table_info(messages)") if c[1] not in ("id", "active", "compacted", "display_order")]
    for active, compacted in ((0, 1), (0, 0)):  # what compaction archives, what a rewind sets aside
        raw.execute("INSERT INTO messages (%s, active, compacted) SELECT %s, ?, ? FROM messages WHERE id = ?" % (", ".join(columns), ", ".join(columns)),
                    (active, compacted, reply))
    raw.commit()
    raw.close()
    return folder, path


def listed(path):
    from hermes_state import SessionDB
    db = SessionDB(path, read_only=True)
    rows = [r for r in api._db_sessions(db) if r["id"] == "chat"]
    return db, rows


def test_the_quick_read_gets_what_a_full_read_gets():
    folder, path = real_store()
    try:
        db, rows = listed(path)
        for kind in ("days", "bulk"):
            _value, _where, of_message, flags, build = api._LIGHT[kind]
            full = build([(m.get("role"), of_message(m)) for m in api._db_messages(db, "chat", **flags)])
            api._SESSION_CACHE.clear()
            reads = []
            get = db.get_messages
            db.get_messages = lambda *a, **kw: reads.append(a) or get(*a, **kw)
            quick = api._light_sessions(db, str(path), rows, kind)["chat"]
            db.get_messages = get
            assert quick == full, (kind, quick, full)
            assert not reads, "no message was loaded"
            assert "message_table" not in api._DEGRADED
        days = api._light_sessions(db, str(path), rows, "days")["chat"]
        assert days == {day_of(NOON - DAY): 12, day_of(NOON): 19}, days
        assert api._light_sessions(db, str(path), rows, "bulk")["chat"] == (10_000 * 20, 10_000)
        db.close()
    finally:
        shutil.rmtree(folder, ignore_errors=True)


def test_it_reads_beside_a_store_hermes_is_writing():
    from hermes_state import SessionDB
    folder, path = real_store()
    try:
        writer = SessionDB(db_path=path)  # Hermes keeps its own connection open in the same process
        reader, rows = listed(path)
        api._SESSION_CACHE.clear()
        before = api._light_sessions(reader, str(path), rows, "days")["chat"]
        writer.append_message("chat", "assistant", "done", timestamp=NOON + 900)
        reader.close()
        reader, rows = listed(path)
        after = api._light_sessions(reader, str(path), rows, "days")["chat"]
        assert sum(after.values()) == sum(before.values()) + 1, (before, after)
        writer.append_message("chat", "user", "thanks", timestamp=NOON + 901)  # and Hermes can still write
        reader.close()
        writer.close()
    finally:
        shutil.rmtree(folder, ignore_errors=True)


def test_a_reply_stored_twice_counts_once():
    marks = [("assistant", NOON), ("assistant", NOON), ("tool", NOON), ("user", NOON + 1), ("assistant", NOON + 5)]
    assert api._session_days(marks) == {day_of(NOON): 2}


class FakeDb:
    def __init__(self):
        self.reads = 0

    def get_messages(self, session_id, **kw):
        self.reads += 1
        return [{"role": "assistant", "timestamp": NOON}, {"role": "tool", "content": "x" * 9_000, "timestamp": NOON + 1}]


ROW = {"id": "s1", "last_active": NOON + 1, "message_count": 2, "api_call_count": 1}


def test_without_the_table_messages_are_loaded_through_hermes():
    api._SESSION_CACHE.clear()
    api._DEGRADED.discard("message_table")
    db = FakeDb()
    got = api._light_sessions(db, "/nowhere/state.db", [ROW], "days")
    assert got == {"s1": {day_of(NOON): 1}} and db.reads == 1
    assert "message_table" in api._DEGRADED, "health says the quick read is off"
    api._light_sessions(db, "/nowhere/state.db", [ROW], "days")
    assert db.reads == 1, "kept until the session changes"
    folder, path = real_store()
    try:
        real, rows = listed(path)
        api._light_sessions(real, str(path), rows, "days")
        real.close()
        assert "message_table" not in api._DEGRADED, "and says it is back once a read works"
    finally:
        shutil.rmtree(folder, ignore_errors=True)


def test_requests_arriving_together_share_one_read():
    api._SESSION_CACHE.clear()
    calls = []
    read = api._light_read

    def slow(store, kind, ids):
        calls.append(ids)
        time.sleep(0.2)
        return {"s1": [("assistant", NOON)]}

    api._light_read = slow
    try:
        got = []
        threads = [threading.Thread(target=lambda: got.append(api._light_sessions(FakeDb(), "store-shared", [ROW], "days"))) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
    finally:
        api._light_read = read
    assert len(calls) == 1 and got == [{"s1": {day_of(NOON): 1}}] * 4, (len(calls), got)


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
