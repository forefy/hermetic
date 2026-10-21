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
    assert r["action"] == "block" and "nobody was at Hermes" in r["message"] and time.time() - t < 1


def test_ask_waits_for_your_answer():
    set_level("ask")
    someone_is_there()
    answer_when_asked("allow")
    assert call(*SSH_READ) is None, "allowed"
    someone_is_there()
    answer_when_asked("block")
    r = call(*SSH_READ)
    assert r["action"] == "block" and "the user said no" in r["message"]


def test_no_answer_in_time_blocks():
    set_level("ask")
    someone_is_there()
    plugin._ask_wait = lambda: 0.6
    try:
        r = call(*SSH_READ)
    finally:
        plugin._ask_wait = ASK_WAIT
    assert r["action"] == "block" and "did not answer in time" in r["message"]
    assert not [f for f in plugin.asks_dir().glob("*.json")], "the question is cleaned up"


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
