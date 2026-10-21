"""Config writes reach only the profile Hermes scoped the request to; profiles with no chats are empty.

Run inside Hermes' environment: bash ~/.hermes/hermes-agent/scripts/run-in-hermes-env python3 tests/test_config_routes.py
"""
import asyncio
import importlib.util
import os
import shutil
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
HOME = Path(tempfile.mkdtemp(prefix="hermetic-config-test-"))
os.environ["HERMES_HOME"] = str(HOME)  # a throwaway home, never the real one
(HOME / "config.yaml").write_text("model:\n  default: test/main\n")
P2 = HOME / "profiles" / "p2"
P2.mkdir(parents=True)
(P2 / "config.yaml").write_text("model:\n  default: test/p2\n")

spec = importlib.util.spec_from_file_location("plugin_api", HERE.parent / "dashboard" / "plugin_api.py")
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)


def test_reads_use_the_requested_profile():
    assert "test/p2" in asyncio.run(api.config_raw(profile="p2"))["yaml"]
    assert "test/main" in asyncio.run(api.config_raw(profile=None))["yaml"]


def test_a_write_to_a_profile_hermes_did_not_scope_is_refused():
    # outside a scoped request (an older Hermes), save_config would hit this process's home
    r = asyncio.run(api.config_raw_save({"yaml_text": "model:\n  default: test/changed\n"}, profile="p2"))
    assert r["ok"] is False and "Update Hermes" in r["error"]
    assert (P2 / "config.yaml").read_text() == "model:\n  default: test/p2\n"
    assert "test/changed" not in (HOME / "config.yaml").read_text(), "and the current profile was not written instead"


def test_a_write_to_the_scoped_profile_replaces_the_text():
    r = asyncio.run(api.config_raw_save({"yaml_text": "model:\n  default: test/main\ndisplay:\n  compact: true\n"}, profile=None))
    assert r["ok"] is True
    text = (HOME / "config.yaml").read_text()
    assert "compact: true" in text and "test/main" in text


def test_bad_input_is_refused():
    assert asyncio.run(api.config_raw_save({"yaml_text": "a: [unclosed"}, profile=None))["ok"] is False
    assert asyncio.run(api.config_raw_save({"yaml_text": "- a list"}, profile=None))["ok"] is False


def test_a_profile_without_chats_is_empty():
    assert asyncio.run(api.usage(days=7, profile="p2"))["daily"] == []
    assert asyncio.run(api.sessions(days=7, profile="p2"))["sessions"] == []


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
