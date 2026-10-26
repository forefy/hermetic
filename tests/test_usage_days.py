"""The usage route spreads each session over the days it ran, not just the day it started.

Run inside Hermes' environment: bash ~/.hermes/hermes-agent/scripts/run-in-hermes-env python3 tests/test_usage_days.py
"""
import asyncio
import importlib.util
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("plugin_api", HERE.parent / "dashboard" / "plugin_api.py")
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)

DAY = 86400
NOON = time.mktime(time.strptime(time.strftime("%Y-%m-%d"), "%Y-%m-%d")) + 12 * 3600  # today, local noon
today = time.strftime("%Y-%m-%d", time.localtime(NOON))
day_of = lambda ts: time.strftime("%Y-%m-%d", time.localtime(ts))


def replies(*days_ago):
    return [{"role": "assistant", "timestamp": NOON - n * DAY} for n in days_ago]


class FakeDb:
    def __init__(self, sessions):
        self.sessions = sessions

    def list_sessions_rich(self, **kw):
        return [s["row"] for s in self.sessions]

    def get_messages(self, session_id, **kw):
        return next(s["msgs"] for s in self.sessions if s["row"]["id"] == session_id)

    def auxiliary_usage_by_task(self, session_id):
        return {}

    def close(self):
        pass


def session(sid, started_days_ago, msgs, cost=10.0, tokens=1000):
    row = {"id": sid, "started_at": NOON - started_days_ago * DAY, "last_active": max(m["timestamp"] for m in msgs), "model": "z-ai/glm-5.3",
           "estimated_cost_usd": cost, "input_tokens": tokens, "output_tokens": 0, "cache_read_tokens": 0, "api_call_count": len(msgs),
           "message_count": len(msgs)}
    return {"row": row, "msgs": msgs}


def run(days, sessions):
    api._SESSION_CACHE.clear()
    db = FakeDb(sessions)
    api._open_sessions_db = lambda profile: db
    api._sessions_store = lambda profile: "store"
    return asyncio.run(api.usage(days=days, profile=None))


def test_a_long_chat_still_running_counts_today():
    # started 5 days ago, half its replies today: today gets half its cost
    r = run(1, [session("long", 5, replies(5, 5, 0, 0))])
    assert [d["day"] for d in r["daily"]] == [today]
    assert abs(r["daily"][0]["estimated_cost"] - 5.0) < 1e-9 and r["daily"][0]["input_tokens"] == 500
    assert abs(r["by_model"][0]["estimated_cost"] - 5.0) < 1e-9, "the model total covers only the period's part"


def test_the_week_gets_each_day_its_part():
    r = run(7, [session("long", 5, replies(5, 3, 3, 0))])
    got = {d["day"]: d["estimated_cost"] for d in r["daily"]}
    assert got == {day_of(NOON - 5 * DAY): 2.5, day_of(NOON - 3 * DAY): 5.0, today: 2.5}
    assert sum(d["sessions"] for d in r["daily"]) == 1 and r["daily"][0]["sessions"] == 1, "counted once, on its start day"


def test_a_session_with_no_replies_stays_on_its_start_day():
    s = session("quiet", 0, [{"role": "user", "timestamp": NOON}])
    r = run(1, [s])
    assert r["daily"][0]["day"] == today and r["daily"][0]["estimated_cost"] == 10.0


def test_each_model_says_where_it_was_billed():
    a = session("hop", 0, replies(0))
    a["row"]["billing_base_url"] = "https://api.hopscotchlabs.ai/v1"
    b = session("or", 0, replies(0))
    b["row"]["billing_base_url"] = "https://openrouter.ai/api/v1"
    r = run(1, [a, b])
    assert r["by_model"][0]["hosts"] == ["api.hopscotchlabs.ai", "openrouter.ai"]


def test_old_big_tool_output_is_counted_per_later_call():
    big = {"role": "tool", "content": "x" * 40_000}  # 10k tokens, over the 8,000-character prune size
    small = {"role": "tool", "content": "x" * 4_000}
    msgs = [big, small] + [{"role": "assistant"}] * 50
    resent, bulky = api._session_bulk(msgs)
    # the 20 messages after it are Hermes' protected tail; the replies at positions 21 to 51 come after that
    assert bulky == 10_000 and resent == 10_000 * 31, (resent, bulky)
    assert api._session_bulk([big] + [{"role": "assistant"}] * 20) == (0, 0), "nothing past the protected tail"


def test_sessions_wholly_before_the_period_are_left_out():
    r = run(1, [session("old", 3, replies(3, 2))])
    assert r["daily"] == [] and r["by_model"] == []


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
