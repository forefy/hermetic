"""The HDR guard hook: what it asks about, blocks, ignores, and that its own errors never block.

Run inside Hermes' environment: bash ~/.hermes/hermes-agent/scripts/run-in-hermes-env python3 tests/test_guard.py
"""
import importlib.util
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
HOME = tempfile.mkdtemp(prefix="hermetic-guard-test-")
os.environ["HERMES_HOME"] = HOME  # a throwaway profile, never the real one

spec = importlib.util.spec_from_file_location("hermetic_init", HERE.parent / "__init__.py")
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)
GUARD = Path(HOME) / "hermetic" / "hdr"


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


def test_ask_escalates_risky_calls_to_hermes_approval():
    set_level("ask")
    r = call(*SSH_READ)
    assert r["action"] == "approve" and "~/.ssh/config" in r["message"]
    assert r["rule_key"] == "hermetic:read:~/.ssh/config", "an 'always' answer covers this path only"


def test_block_stops_risky_calls_and_says_why():
    set_level("block")
    r = call(*LAUNCH_WRITE)
    assert r["action"] == "block" and "starts programs at login" in r["message"]


def test_low_scores_and_batch_wrappers_pass():
    set_level("block")
    assert call(*ETC_READ) is None, "reading /etc scores 30, under the line"
    assert call("read_file", {"path": "~/projects/app/main.py"}) is None
    assert call("tool_call", {"calls": [{"name": "terminal", "arguments": {"command": "cat ~/.ssh/id_ed25519"}}]}) is None


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
    assert {r["action"] for r in rows} == {"ask", "block"}
    assert all(r["session_id"] == "s1" and r["score"] >= plugin.GUARD_MIN for r in rows)


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
