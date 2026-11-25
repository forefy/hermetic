"""Costs, HDR and AAI read a few columns of each message instead of loading it, and get what a full read gets.

Run inside Hermes' environment: bash ~/.hermes/hermes-agent/scripts/run-in-hermes-env python3 tests/test_quick_reads.py
"""
import importlib.util
import json
import shutil
import sqlite3
import sys
import tempfile
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from _store import add_chat, add_messages, writer  # noqa: E402

spec = importlib.util.spec_from_file_location("plugin_api", HERE.parent / "dashboard" / "plugin_api.py")
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)

DAY = 86400
NOON = time.mktime(time.strptime(time.strftime("%Y-%m-%d"), "%Y-%m-%d")) + 12 * 3600  # today, local noon
day_of = lambda ts: time.strftime("%Y-%m-%d", time.localtime(ts))
COMMANDS = ["cat ~/.ssh/config", "curl -s https://api.github.com/x > /tmp/out.json", "ls /tmp"]


def call(call_id, tool, **args):
    return {"id": call_id, "type": "function", "function": {"name": tool, "arguments": json.dumps(args)}}


def real_store(extra=()):
    """A real Hermes session store with one chat over two days: a request, 31 tool rounds (a big tool
    result first, one round loads a skill), a closing reply and a complaint about it. ``extra`` adds
    messages at the end."""
    folder = Path(tempfile.mkdtemp(prefix="hermetic-quick-"))
    path = folder / "state.db"
    db = writer(path)
    msgs = [{"role": "user", "content": "go", "timestamp": NOON - DAY}]
    for i in range(31):
        ts = NOON - DAY + 10 * i if i < 12 else NOON + 10 * i
        made = call("call_%d" % i, "skill_view", name="notes") if i == 5 else call("call_%d" % i, "terminal", command=COMMANDS[i % 3])
        msgs.append({"role": "assistant", "content": "", "timestamp": ts, "tool_calls": [made]})
        msgs.append({"role": "tool", "content": "x" * (40_000 if i == 0 else 300), "tool_call_id": made["id"],
                     "tool_name": made["function"]["name"], "timestamp": ts + 1})
    msgs.append({"role": "assistant", "content": "All done.", "timestamp": NOON + 400})
    msgs.append({"role": "user", "content": "no, that is wrong, you forgot the tests", "timestamp": NOON + 500})
    add_chat(db, "chat", msgs + list(extra))
    db.close()
    return folder, path


def copy_row(raw, row_id, active, compacted, **changed):
    """A second copy of a stored message, the way compaction (archived) and rewind (set aside) leave one."""
    columns = [c[1] for c in raw.execute("PRAGMA table_info(messages)") if c[1] not in ("id", "active", "compacted", "display_order", *changed)]
    raw.execute("INSERT INTO messages (%s, active, compacted%s) SELECT %s, ?, ?%s FROM messages WHERE id = ?"
                % (", ".join(columns), "".join(", " + k for k in changed), ", ".join(columns), ", ?" * len(changed)),
                (active, compacted, *changed.values(), row_id))


def listed(path):
    db = api._StoreReader(path)
    return db, [r for r in api._db_sessions(db) if r["id"] == "chat"]


def both_ways(path, kind):
    """(the kind read quickly, the kind from Hermes' full listing, full listings the quick read asked for)."""
    db, rows = listed(path)
    try:
        full, flags = api._LIGHT[kind][3:]
        slow = full(api._db_messages(db, "chat", **flags))
        api._SESSION_CACHE.clear()
        api._DEGRADED.discard("message_table")
        loads = []
        get = db.get_messages
        db.get_messages = lambda *a, **kw: loads.append(a) or get(*a, **kw)
        quick = api._light_sessions(db, str(path), rows, kind)["chat"]
        return quick, slow, len(loads)
    finally:
        db.close()


def test_the_quick_read_gets_what_a_full_read_gets():
    folder, path = real_store()
    try:
        got = {}
        for kind in api._LIGHT:
            quick, slow, loads = both_ways(path, kind)
            assert quick == slow, (kind, quick, slow)
            assert not loads, "no message was loaded for " + kind
            assert "message_table" not in api._DEGRADED
            got[kind] = quick
        assert got["days"] == {day_of(NOON - DAY): 12, day_of(NOON): 20}, got["days"]
        assert got["bulk"] == (10_000 * 21, 10_000), got["bulk"]
        assert [c[1] for c in got["calls"]].count("terminal") == 30 and got["calls"][1][3] == (None, {"api.github.com"})
        assert got["skills"] == [(NOON - DAY + 50, "notes")], got["skills"]
        assert [(role, text) for _id, role, _ts, text, _skills in got["shown_turns"] if text] == [
            ("user", "go"), ("assistant", "All done."), ("user", "no, that is wrong, you forgot the tests")]
    finally:
        shutil.rmtree(folder, ignore_errors=True)


def test_stored_copies_are_listed_the_way_hermes_lists_them():
    folder, path = real_store()
    try:
        raw = sqlite3.connect(path)
        reply = lambda n: raw.execute("SELECT id FROM messages WHERE role = 'assistant' AND tool_calls LIKE ?", ("%%call_%d\"%%" % n,)).fetchone()[0]
        copy_row(raw, reply(0), 0, 1)  # what compaction archives
        copy_row(raw, reply(1), 0, 0)  # what a rewind sets aside
        # a reply compaction carried forward with its arguments cut: the same call id, so the same reply
        raw.execute("UPDATE messages SET active = 0, compacted = 1 WHERE id = ?", (reply(2),))
        copy_row(raw, reply(2), 1, 0, tool_calls=json.dumps([call("call_2", "terminal", command="[cut]")]))
        copy_row(raw, raw.execute("SELECT id FROM messages WHERE content = 'All done.'").fetchone()[0], 0, 1)
        # turns Hermes merged for the model alone are in no listing
        raw.execute("UPDATE messages SET display_metadata = ? WHERE content = 'go'", (json.dumps({"model_only": True}),))
        raw.commit()
        raw.close()
        for kind in api._LIGHT:
            quick, slow, loads = both_ways(path, kind)
            assert quick == slow and not loads, (kind, quick, slow)
        calls = both_ways(path, "calls")[0]
        assert len(calls) == 31 and [c[2] for c in calls if c[2].get("command") == "[cut]"], "one of each reply, the live copy of the cut one"
        texts = [text for _id, _role, _ts, text, _skills in both_ways(path, "shown_turns")[0]]
        assert texts.count("All done.") == 1 and "go" not in texts
    finally:
        shutil.rmtree(folder, ignore_errors=True)


def test_a_reply_only_the_model_sees_has_no_tool_calls_to_show():
    row = lambda n, notes: (n, 1, NOON + n, None, json.dumps([call("c%d" % n, "terminal", command="ls")]), None, "", notes)
    hidden = json.dumps({"model_only": True})
    kept = api._quick_tool_calls([row(1, None), row(2, hidden), row(3, json.dumps(hidden)), row(4, "not json")])
    assert [m["timestamp"] for m in kept] == [NOON + 1, NOON + 4]


def test_odd_texts_come_out_the_same():
    parts = [{"type": "text", "text": "look at this picture"}, {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}}]
    extra = [{"role": "user", "content": parts, "timestamp": NOON + 600},
             {"role": "assistant", "content": "word " * 900, "timestamp": NOON + 610},
             {"role": "user", "content": "a" + " " * 3000 + "table", "timestamp": NOON + 620},
             {"role": "assistant", "content": "", "timestamp": NOON + 630}]
    folder, path = real_store(extra[:2])
    try:
        quick, slow, loads = both_ways(path, "shown_turns")
        assert quick == slow and not loads
        assert quick[-2][3].startswith("[{'type': 'text'") and len(quick[-1][3]) == api._TURN_CHARS
    finally:
        shutil.rmtree(folder, ignore_errors=True)
    folder, path = real_store(extra)
    try:
        quick, slow, loads = both_ways(path, "shown_turns")
        assert quick == slow and loads == 1, "a text that is mostly spaces is read in full, through Hermes"
        assert quick[-2][3] == "a table" and "message_table" not in api._DEGRADED
    finally:
        shutil.rmtree(folder, ignore_errors=True)


def test_a_chat_hermes_has_not_given_places_is_listed_by_hermes():
    folder, path = real_store()
    try:
        raw = sqlite3.connect(path)
        raw.execute("UPDATE messages SET display_order = NULL")
        raw.commit()
        raw.close()
        quick, slow, loads = both_ways(path, "shown_turns")
        assert quick == slow and loads == 1 and "message_table" not in api._DEGRADED
        assert both_ways(path, "calls")[2] == 0, "only the conversation as shown needs the places"
    finally:
        shutil.rmtree(folder, ignore_errors=True)


def test_hdr_works_out_paths_for_the_period_on_screen_only():
    folder, path = real_store()
    home = api._profile_home
    api._profile_home = lambda profile: ("default", folder)
    try:
        api._SESSION_CACHE.clear()
        calls = list(api._hdr_calls(None, 0, NOON))
        old = [c for c in calls if c[2] < NOON]
        new = [c for c in calls if c[2] >= NOON]
        assert len(old) == 12 and len(new) == 19
        assert all(c[6][0] is None for c in old), "no paths before the period"
        assert ("~/.ssh/config", "read") in [p for c in new for p in c[6][0]]
        assert {h for c in old for h in c[6][1]} == {"api.github.com"}, "hosts for the whole time HDR has known them"
        again = list(api._hdr_calls(None, 0, NOON - 2 * DAY))
        assert all(c[6][0] is not None for c in again), "a longer period fills in the rest"
    finally:
        api._profile_home = home
        shutil.rmtree(folder, ignore_errors=True)


def test_it_reads_beside_a_store_hermes_is_writing():
    folder, path = real_store()
    try:
        hermes = writer(path)  # Hermes keeps its own connection open in the same process
        reader, rows = listed(path)
        api._SESSION_CACHE.clear()
        before = api._light_sessions(reader, str(path), rows, "days")["chat"]
        add_messages(hermes, "chat", [{"role": "assistant", "content": "done", "timestamp": NOON + 900}])
        reader.close()
        reader, rows = listed(path)
        after = api._light_sessions(reader, str(path), rows, "days")["chat"]
        assert sum(after.values()) == sum(before.values()) + 1, (before, after)
        add_messages(hermes, "chat", [{"role": "user", "content": "thanks", "timestamp": NOON + 901}])  # and Hermes can still write
        reader.close()
        hermes.close()
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
    folder, path = real_store()
    read = api._light_read
    calls = []

    def slow(conn, kind, sid):
        calls.append(sid)
        time.sleep(0.2)
        return read(conn, kind, sid)

    api._light_read = slow
    try:
        db, rows = listed(path)
        api._SESSION_CACHE.clear()
        got = []
        threads = [threading.Thread(target=lambda: got.append(api._light_sessions(db, str(path), rows, "days"))) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        db.close()
    finally:
        api._light_read = read
        shutil.rmtree(folder, ignore_errors=True)
    assert len(calls) == 1 and len(got) == 4 and all(g == got[0] for g in got), (len(calls), got)


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
