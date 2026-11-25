"""A first read of a long history never runs into the app's request limit: the route says how far it is.

Run inside Hermes' environment: bash ~/.hermes/hermes-agent/scripts/run-in-hermes-env python3 tests/test_reading.py
"""
import asyncio
import importlib.util
import json
import shutil
import sqlite3
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from _store import add_chat, writer  # noqa: E402

spec = importlib.util.spec_from_file_location("plugin_api", HERE.parent / "dashboard" / "plugin_api.py")
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)
api._ANSWER_WAIT_S = 0.15
api._hdr_services = lambda calls: []  # this machine's open ports are not under test

NOW = time.time()
CHATS = 12


def store():
    """A real Hermes session store with a dozen short chats, each with one tool call."""
    folder = Path(tempfile.mkdtemp(prefix="hermetic-reading-"))
    db = writer(folder / "state.db")
    for i in range(CHATS):
        sid = "chat-%d" % i
        call = {"id": "call_%d" % i, "type": "function", "function": {"name": "terminal", "arguments": json.dumps({"command": "curl https://example.com/%d" % i})}}
        add_chat(db, sid, [{"role": "user", "content": "go", "timestamp": NOW - 60},
                           {"role": "assistant", "content": "", "timestamp": NOW - 50, "tool_calls": [call]},
                           {"role": "tool", "content": "ok", "tool_call_id": call["id"], "tool_name": "terminal", "timestamp": NOW - 49},
                           {"role": "assistant", "content": "Done.", "timestamp": NOW - 40}])
    db.close()
    # the token counters are the store's own columns: set here as a finished chat has them
    raw = sqlite3.connect(folder / "state.db")
    raw.execute("UPDATE sessions SET input_tokens = 10, output_tokens = 5, api_call_count = 2")
    raw.commit()
    raw.close()
    return folder


def slowly(seconds):
    """Makes every session take ``seconds`` to read, as a long history on a slow disk does."""
    read = api._light_read

    def slow(conn, kind, sid):
        time.sleep(seconds)
        return read(conn, kind, sid)

    api._light_read = slow
    return lambda: setattr(api, "_light_read", read)


async def until_read(ask):
    """What the popover does: ask again while the answer is how far the read is."""
    seen, started = [], time.perf_counter()
    while True:
        asked = time.perf_counter()
        got = await ask()
        longest = time.perf_counter() - asked
        if not (isinstance(got, dict) and "reading" in got):
            return got, seen, time.perf_counter() - started
        assert longest < 1.0, "an ask that waited %.1fs" % longest
        seen.append(got["reading"])
        await asyncio.sleep(0.02)


def fresh(folder):
    api._profile_home = lambda profile: ("default", folder)
    api._SESSION_CACHE.clear()
    api._ANSWERS.clear()


def test_a_slow_first_read_answers_with_progress_then_the_same_answer():
    folder, home = store(), api._profile_home
    undo = slowly(0.1)  # 12 chats: 1.2 seconds, eight times the wait
    try:
        fresh(folder)
        got, seen, took = asyncio.run(until_read(lambda: api.hdr(days=7, profile=None, reading=1)))
        assert len(seen) >= 3 and took > 1.0, (len(seen), took)
        assert all(r["total"] == CHATS for r in seen if r["total"]) and max(r["done"] for r in seen) > 0, seen
        assert [r["done"] for r in seen] == sorted(r["done"] for r in seen), "progress only goes up"
        undo()
        fresh(folder)
        plain = asyncio.run(api.hdr(days=7, profile=None))
        assert "error" not in got and json.dumps(got, sort_keys=True, default=str) == json.dumps(plain, sort_keys=True, default=str), \
            "the answer is the one a plain ask gets"
        assert got["domains"][0]["domain"] == "example.com" and got["domains"][0]["calls"] == CHATS
    finally:
        undo()
        api._profile_home = home
        shutil.rmtree(folder, ignore_errors=True)


def test_every_route_that_reads_sessions_can_say_it_is_reading():
    folder, home = store(), api._profile_home
    asks = {"usage": lambda: api.usage(days=7, profile=None, reading=1), "sessions": lambda: api.sessions(days=7, profile=None, reading=1),
            "aai": lambda: api.aai(days=7, profile=None, reading=1), "corrections": lambda: api.aai_corrections(days=14, profile=None, reading=1),
            "queue": lambda: api.aai_rate_queue(n=5, first=None, skip=None, profile=None, reading=1),
            "quality": lambda: api.quality(profile=None, reading=1), "hdr": lambda: api.hdr(days=7, profile=None, reading=1)}
    undo = slowly(0.05)
    try:
        for name, ask in asks.items():
            fresh(folder)
            got, seen, _took = asyncio.run(until_read(ask))
            assert seen, name + " never said it was reading"
            assert isinstance(got, dict) and "reading" not in got and "error" not in got, (name, got)
    finally:
        undo()
        api._profile_home = home
        shutil.rmtree(folder, ignore_errors=True)


def test_an_older_popover_still_gets_the_whole_answer_in_one_go():
    folder, home = store(), api._profile_home
    undo = slowly(0.05)
    try:
        fresh(folder)
        got = asyncio.run(api.usage(days=7, profile=None))
        assert "daily" in got and "reading" not in got
    finally:
        undo()
        api._profile_home = home
        shutil.rmtree(folder, ignore_errors=True)


def test_a_quick_answer_comes_at_once_and_an_error_is_still_an_error():
    async def both():
        quick = await api._answer(("t", 1), lambda: {"ok": True}, 1)
        try:
            await api._answer(("t", 2), lambda: 1 / 0, 1)
        except ZeroDivisionError:
            return quick, True
        return quick, False
    assert asyncio.run(both()) == ({"ok": True}, True)


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
