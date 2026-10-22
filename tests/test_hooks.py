"""HDR's hooks monitoring, and the routes behind the guard's own Ask.

Run inside Hermes' environment: bash ~/.hermes/hermes-agent/scripts/run-in-hermes-env python3 tests/test_hooks.py
"""
import asyncio
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
HOME = Path(tempfile.mkdtemp(prefix="hermetic-hooks-test-"))
os.environ["HERMES_HOME"] = str(HOME)  # a throwaway home, never the real one

spec = importlib.util.spec_from_file_location("plugin_api", HERE.parent / "dashboard" / "plugin_api.py")
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)

SCRIPT = HOME / "agent-hooks" / "block-prod.sh"
SCRIPT.parent.mkdir()
SCRIPT.write_text('#!/bin/sh\nif echo "$CMD" | grep -q prod; then\n  echo block\nfi\n')
GW = HOME / "hooks" / "digest"
GW.mkdir(parents=True)
(GW / "HOOK.yaml").write_text("name: digest\nevents:\n  - agent:end\n")
(GW / "handler.py").write_text("def handle(event, ctx):\n    pass\n")
CFG = {"hooks": {"pre_tool_call": [{"matcher": "terminal", "command": str(SCRIPT)}],
                 "pre_llm_call": [{"command": "python3 -c 'print(1)'"}]}}
(HOME / "shell-hooks-allowlist.json").write_text(json.dumps({"approvals": [{"event": "pre_tool_call", "command": str(SCRIPT)}]}))


def hooks(cfg=CFG):
    return {h["event"]: h for h in api._hdr_hooks(HOME, cfg)["hooks"]}


def test_every_hook_is_listed_with_what_it_can_do():
    hs = hooks()
    assert hs["pre_tool_call"]["can"] == "Can block or change tool calls" and hs["pre_tool_call"]["approved"] is True
    assert hs["pre_llm_call"]["approved"] is False and not hs["pre_llm_call"]["runs_unasked"]
    assert hs["agent:end"]["kind"] == "gateway" and hs["agent:end"]["approved"] is None
    assert not any(h["new"] for h in hs.values()), "hooks there before HDR first looked are not new"


def test_an_edited_script_shows_what_changed_until_reviewed():
    SCRIPT.write_text('#!/bin/sh\nif false; then\n  echo block\nfi\n')
    h = hooks()["pre_tool_call"]
    assert h.get("changed") and '+if false; then' in h["diff"] and any(x.startswith("-if echo") for x in h["diff"])
    r = asyncio.run(api.hdr_hooks_reviewed({"key": h["key"]}, profile=None))
    assert r["ok"] and not hooks()["pre_tool_call"].get("changed")


def test_new_hooks_and_auto_accept():
    cfg = {"hooks": dict(CFG["hooks"], on_session_start=[{"command": "curl -s https://hooks.example.dev/ping"}]), "hooks_auto_accept": True}
    hs = hooks(cfg)
    assert hs["on_session_start"]["new"] and hs["on_session_start"]["runs_unasked"]
    assert api._hdr_hooks(HOME, cfg)["auto_accept"] is True


def test_the_popover_lists_and_answers_questions():
    d = api._asks_dir()
    d.mkdir(parents=True, exist_ok=True)
    ask = {"id": "0123456789ab", "ts": time.time(), "until": time.time() + 20, "tool": "read_file", "path": "~/.ssh/config",
           "op": "read", "why": "SSH keys", "kind": "keys", "folder": "~/.ssh", "session_id": "s1", "profile": "default"}
    (d / "0123456789ab.json").write_text(json.dumps(ask))
    got = asyncio.run(api.hdr_guard_asks(profile=None))["asks"]
    assert [a["id"] for a in got] == ["0123456789ab"] and 0 < got[0]["left"] <= 20
    assert time.time() - (d / "seen").stat().st_mtime < 2, "listing tells the guard someone is there"
    r = asyncio.run(api.hdr_guard_answer({"id": "0123456789ab", "decision": "allow", "scope": "folder", "remember": "always"}, profile=None))
    assert r["ok"] and json.loads((d / "0123456789ab.answer.json").read_text())["decision"] == "allow"
    rules = api._hdr_guard_read(HOME)["rules"]
    assert rules[-1]["scope"] == "folder" and rules[-1]["folder"] == "~/.ssh" and "session_id" not in rules[-1]
    assert asyncio.run(api.hdr_guard_asks(profile=None))["asks"] == [], "answered questions drop out"


def test_the_script_is_found_behind_an_interpreter():
    assert api._hook_script("bash " + str(SCRIPT)) == SCRIPT
    assert api._hook_script("/usr/bin/env sh " + str(SCRIPT) + " --flag") == SCRIPT, "skips the env binary"
    assert api._hook_script("python3 -c 'print(1)'") is None


def test_bad_answers_are_refused():
    for bad in ({"id": "../../x", "decision": "allow"}, {"id": "0123456789ab", "decision": "maybe"},
                {"id": "0123456789ab", "decision": "allow", "scope": "everything"}):
        assert asyncio.run(api.hdr_guard_answer(bad, profile=None))["ok"] is False


def test_rules_can_be_removed_and_the_level_kept():
    asyncio.run(api.hdr_guard({"level": "ask"}, profile=None))
    n = len(api._hdr_guard_read(HOME)["rules"])
    asyncio.run(api.hdr_guard({"remove_rule": n - 1}, profile=None))
    g = api._hdr_guard_read(HOME)
    assert len(g["rules"]) == n - 1 and g["level"] == "ask"


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
