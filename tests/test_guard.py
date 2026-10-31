"""The HDR guard hook: what it asks about, blocks, ignores, and that its own errors never block.

Run inside Hermes' environment: bash ~/.hermes/hermes-agent/scripts/run-in-hermes-env python3 tests/test_guard.py
"""
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
HOME = tempfile.mkdtemp(prefix="hermetic-guard-test-")
os.environ["HERMES_HOME"] = HOME  # a throwaway profile, never the real one

spec = importlib.util.spec_from_file_location("hermetic_init", HERE.parent / "__init__.py")
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)
GUARD = Path(HOME) / "hermetic" / "hdr"
ASK_WAIT = plugin._ask_wait


def set_level(level):
    GUARD.mkdir(parents=True, exist_ok=True)
    p = GUARD / "guard.json"
    p.write_text(json.dumps({"level": level}))
    os.utime(p, (p.stat().st_atime, p.stat().st_mtime + len(plugin._GUARD_CACHE) + 1))  # a new mtime for the cache


def call(name, args):
    return plugin._on_pre_tool_call(tool_name=name, args=args, task_id="t1", session_id="s1")


SSH_READ = ("terminal", {"command": "cat ~/.ssh/config"})
LAUNCH_WRITE = ("write_file", {"path": "~/Library/LaunchAgents/com.example.sync.plist", "content": "x"})
ETC_READ = ("terminal", {"command": "cat /etc/hosts"})


def test_watch_is_the_default_and_never_stops():
    assert plugin.guard_level() == "watch"
    assert call(*SSH_READ) is None and call(*LAUNCH_WRITE) is None


def answer_when_asked(decision, delay=0.3):
    """Play the popover: wait for the question, then answer it."""
    import threading

    def run():
        d = plugin.asks_dir()
        for _ in range(40):
            qs = [f for f in d.glob("*.json") if not f.name.endswith(".answer.json")] if d.is_dir() else []
            if qs:
                aid = qs[0].name[:-5]
                (d / (aid + ".answer.json")).write_text(json.dumps({"decision": decision, "how": "you"}))
                return
            time.sleep(0.05)
    threading.Timer(delay, run).start()


def someone_is_there():
    d = plugin.asks_dir()
    d.mkdir(parents=True, exist_ok=True)
    (d / "seen").touch()


def test_ask_with_nobody_at_the_popover_blocks_at_once():
    set_level("ask")
    seen = plugin.asks_dir() / "seen"
    if seen.exists():
        seen.unlink()
    t = time.time()
    r = call(*SSH_READ)
    assert r["action"] == "block" and "Hermes wasn't open" in r["message"] and time.time() - t < 1


def test_ask_waits_for_your_answer():
    set_level("ask")
    someone_is_there()
    answer_when_asked("allow")
    assert call(*SSH_READ) is None, "allowed"
    someone_is_there()
    answer_when_asked("block")
    r = call(*SSH_READ)
    assert r["action"] == "block" and "rejected by the user" in r["message"]


def test_no_answer_in_time_blocks():
    set_level("ask")
    someone_is_there()
    plugin._ask_wait = lambda: 0.6
    try:
        r = call(*SSH_READ)
    finally:
        plugin._ask_wait = ASK_WAIT
    assert r["action"] == "block" and "no answer in time" in r["message"]
    left = list(plugin.asks_dir().glob("*.json"))
    assert [f.name.endswith(".outcome.json") for f in left] == [True], "the question is cleaned up, what happened is left"
    o = json.loads(left[0].read_text())
    assert o["how"] == "no answer" and o["path"] == "~/.ssh/config" and o["tool"] == "terminal"
    left[0].unlink()


def test_the_wait_follows_hermes_hook_limit():
    import types
    real = sys.modules.get("hermes_cli.config")
    try:
        for value, wait in [(None, 24.0), (120, 114.0), (0, plugin._ASK_NO_LIMIT_S), (900, 594.0), (-5, 24.0), (5, 3.0)]:
            fake = types.ModuleType("hermes_cli.config")
            fake.load_config_readonly = lambda v=value: {"plugins": {} if v is None else {"hook_callback_timeout": v}}
            sys.modules["hermes_cli.config"] = fake
            assert plugin._ask_wait() == wait, (value, plugin._ask_wait())
    finally:
        if real is not None:
            sys.modules["hermes_cli.config"] = real
        else:
            sys.modules.pop("hermes_cli.config", None)


def test_the_popover_hears_about_a_question_that_ran_out():
    import asyncio
    api_spec = importlib.util.spec_from_file_location("plugin_api", HERE.parent / "dashboard" / "plugin_api.py")
    api = importlib.util.module_from_spec(api_spec)
    api_spec.loader.exec_module(api)
    d = api._asks_dir()
    d.mkdir(parents=True, exist_ok=True)
    now = time.time()
    fresh = {"id": "aaa", "tool": "terminal", "path": "~/.ssh", "op": "read", "why": "SSH keys", "session_id": None, "profile": "default", "ts": now - 5, "how": "no answer"}
    (d / "aaa.outcome.json").write_text(json.dumps(fresh))
    (d / "bbb.outcome.json").write_text(json.dumps(dict(fresh, id="bbb", ts=now - 300)))
    (d / "ccc.outcome.json").write_text(json.dumps(dict(fresh, id="ccc", ts=now - 3600)))
    r = asyncio.run(api.hdr_guard_asks(profile=None, wait=0, have=""))
    assert r["asks"] == [] and [o["id"] for o in r["ran_out"]] == ["aaa"], "only the last two minutes are shown"
    assert (d / "bbb.outcome.json").exists() and not (d / "ccc.outcome.json").exists(), "old ones are cleared"
    for f in d.glob("*.outcome.json"):
        f.unlink()


def test_the_popover_request_is_held_until_a_question_comes():
    """A background window's timers fire about once a minute, so the popover keeps one request open instead."""
    import asyncio
    import threading
    api_spec = importlib.util.spec_from_file_location("plugin_api", HERE.parent / "dashboard" / "plugin_api.py")
    api = importlib.util.module_from_spec(api_spec)
    api_spec.loader.exec_module(api)
    d = api._asks_dir()
    d.mkdir(parents=True, exist_ok=True)
    key = asyncio.run(api.hdr_guard_asks(profile=None, wait=0, have=""))["key"]
    t = time.time()
    assert asyncio.run(api.hdr_guard_asks(profile=None, wait=1.5, have=key))["asks"] == [] and time.time() - t >= 1, "nothing new: held"
    seen = (d / "seen").stat().st_mtime
    assert time.time() - seen < 1, "while held, the guard can tell someone is at Hermes"
    now = time.time()
    ask = {"id": "q1", "ts": now, "until": now + 4, "tool": "terminal", "path": "~/.ssh/config", "op": "read", "why": "SSH keys", "session_id": None, "profile": "default"}
    threading.Timer(0.7, lambda: (d / "q1.json").write_text(json.dumps(ask))).start()
    t = time.time()
    r = asyncio.run(api.hdr_guard_asks(profile=None, wait=10, have=key))
    assert [a["id"] for a in r["asks"]] == ["q1"] and time.time() - t < 2.5, "a new question answers the held request at once"
    (d / "q1.answer.json").write_text(json.dumps({"decision": "block"}))
    t = time.time()
    assert asyncio.run(api.hdr_guard_asks(profile=None, wait=10, have=r["key"]))["asks"] == [] and time.time() - t < 1.5, "and so does its answer"
    (d / "q1.answer.json").unlink()
    (d / "q1.json").unlink()


def save_rules(level, rules):
    GUARD.mkdir(parents=True, exist_ok=True)
    p = GUARD / "guard.json"
    p.write_text(json.dumps({"level": level, "rules": rules}))
    os.utime(p, (p.stat().st_atime, p.stat().st_mtime + len(plugin._GUARD_CACHE) + 7))
    plugin._GUARD_CACHE.clear()


def test_saved_rules_answer_without_asking():
    save_rules("ask", [{"decision": "allow", "scope": "folder", "op": "read", "folder": "~/.ssh"}])
    assert call("read_file", {"path": "~/.ssh/known_hosts"}) is None, "folder rule"
    save_rules("ask", [{"decision": "block", "scope": "kind", "op": "read", "kind": "keys"}])
    r = call("read_file", {"path": "~/.aws/credentials"})
    assert r["action"] == "block" and "rule" in r["message"]
    save_rules("block", [{"decision": "allow", "scope": "file", "op": "read", "path": "~/.ssh/config", "session_id": "other-chat"}])
    assert call(*SSH_READ)["action"] == "block", "a rule for another chat does not apply"
    save_rules("block", [{"decision": "allow", "scope": "file", "op": "read", "path": "~/.ssh/config", "session_id": "s1"}])
    assert call(*SSH_READ) is None, "a rule for this chat does"


def test_a_call_touching_several_places_needs_all_of_them_allowed():
    cmd = ("terminal", {"command": "cp ~/.ssh/id_ed25519 ~/Library/LaunchAgents/x.plist"})
    save_rules("block", [{"decision": "allow", "scope": "folder", "op": "read", "folder": "~/.ssh"}])
    r = call(*cmd)
    assert r["action"] == "block" and "LaunchAgents" in r["message"], "the startup write is still blocked"


def test_block_stops_risky_calls_and_says_why():
    set_level("block")
    r = call(*LAUNCH_WRITE)
    assert r["action"] == "block" and "starts programs at login" in r["message"]


def test_low_scores_and_batch_wrappers_pass():
    set_level("block")
    assert call(*ETC_READ) is None, "reading /etc scores 30, under the line"
    assert call("read_file", {"path": "~/projects/app/main.py"}) is None
    assert call("tool_call", {"calls": [{"name": "terminal", "arguments": {"command": "cat ~/.ssh/id_ed25519"}}]}) is None


def test_writes_hermes_checks_itself_are_left_to_hermes():
    set_level("block")
    assert call("terminal", {"command": "echo 'export X=1' >> ~/.zshrc"}) is None, "Hermes asks before shell settings"
    assert call("write_file", {"path": "~/.ssh/authorized_keys", "content": "x"}) is None, "Hermes guards SSH writes"
    assert call("write_file", {"path": "~/projects/app/.env", "content": "x"}) is None


def test_key_places_hermes_does_not_check_are_guarded():
    set_level("block")
    assert call("write_file", {"path": "~/.aws/credentials", "content": "x"})["action"] == "block"
    assert call("read_file", {"path": "~/projects/app/.env"})["action"] == "block", "reads of keys files"
    assert call("terminal", {"command": "ls ~/Library/LaunchAgents/"}) is None, "looking at startup items is fine"


def test_its_own_errors_never_block():
    set_level("block")
    assert call("terminal", None) is None
    assert call("terminal", {"command": object()}) is None


def test_bad_settings_fall_back_to_watch():
    GUARD.mkdir(parents=True, exist_ok=True)
    (GUARD / "guard.json").write_text("{not json")
    os.utime(GUARD / "guard.json", None)
    plugin._GUARD_CACHE.clear()
    assert plugin.guard_level() == "watch"


def test_each_stop_is_logged():
    rows = [json.loads(x) for x in (GUARD / "guard.jsonl").read_text().splitlines()]
    assert {r["action"] for r in rows} == {"allow", "block"}
    assert {r["how"] for r in rows} >= {"you", "no answer", "nobody to ask", "your rule", "guard set to block"}
    assert all(r["session_id"] == "s1" and r["why"] for r in rows)


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
