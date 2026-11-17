"""Whether Hermes ever updates this hermetic by itself, from how it installed it: a linked folder and an
install held at one commit never move, and the fix for each.

Run inside Hermes' environment: bash ~/.hermes/hermes-agent/scripts/run-in-hermes-env python3 tests/test_updates.py
"""
import importlib.util
import json
import shutil
import sys
import tempfile
from pathlib import Path

import hermes_cli.config
import hermes_constants

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("plugin_api", HERE.parent / "dashboard" / "plugin_api.py")
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)

HOME = Path(tempfile.mkdtemp(prefix="hermetic-updates-test-"))
PLUGINS = HOME / "plugins"
CONFIG = {}
hermes_constants.get_hermes_home = lambda: HOME  # only this module's view of the home; nothing is installed
hermes_cli.config.load_config_readonly = lambda *a, **k: CONFIG


def installed(record=None, link=False):
    shutil.rmtree(PLUGINS, ignore_errors=True)
    PLUGINS.mkdir(parents=True)
    if link:
        (PLUGINS / "hermetic").symlink_to(HERE.parent)
    else:
        (PLUGINS / "hermetic").mkdir()
    if record is not None:
        (PLUGINS / ".install-metadata.json").write_text(json.dumps({"hermetic": record}))


def test_a_linked_folder_never_updates():
    installed(link=True)
    s = api._update_state()
    assert s["never"] and s["why"] == "link" and s["auto"] is False and s["fix"] is None, s


def test_a_catalog_install_follows_the_catalog():
    installed({"pinned": True, "revision": "a" * 40, "source": "https://github.com/forefy/hermetic.git",
               "catalog": {"name": "hermetic", "pin": "a" * 40}})
    s = api._update_state()
    assert s["never"] is False and s["fix"] == "hermes plugins update hermetic", s


def test_a_tracked_github_install_is_updated():
    installed({"pinned": False, "revision": "b" * 40, "source": "https://github.com/forefy/hermetic.git"})
    s = api._update_state()
    assert s["never"] is False and s["fix"] == "hermes plugins update hermetic", s


def test_an_install_at_a_fixed_commit_never_updates_and_is_reinstalled_unpinned():
    installed({"pinned": True, "revision": "bcb2cd19b6facfd8fbd1f53e4ae32a9925101823", "source": "https://github.com/someone/hermetic.git"})
    s = api._update_state()
    assert s["never"] and s["why"] == "pinned" and s["auto"] is False, s
    assert s["fix"] == "hermes plugins remove hermetic && hermes plugins install https://github.com/someone/hermetic --enable --force", s


def test_a_source_that_is_not_a_plain_repo_address_is_not_put_in_the_command():
    installed({"pinned": True, "revision": "c" * 40, "source": "https://x.example/a/b; rm -rf ~"})
    assert api._update_state()["fix"].endswith("install https://github.com/forefy/hermetic --enable --force")


def test_a_catalog_install_held_at_a_chosen_commit_is_moved_by_an_update():
    installed({"pinned": True, "revision": "d" * 40, "source": "https://github.com/forefy/hermetic.git", "catalog": {"name": "hermetic", "pin": ""}})
    s = api._update_state()
    assert s["never"] and s["why"] == "held" and s["auto"] is False and s["fix"] == "hermes plugins update hermetic", s


def test_an_install_hermes_can_move_follows_the_automatic_updates_switch():
    installed({"pinned": False, "revision": "e" * 40, "source": "https://github.com/forefy/hermetic.git"})
    CONFIG.clear()
    assert api._update_state()["auto"] is False
    CONFIG["plugins"] = {"auto_apply": True}
    assert api._update_state()["auto"] is True
    installed({"pinned": True, "revision": "e" * 40, "source": "https://github.com/forefy/hermetic.git"})
    assert api._update_state()["auto"] is False, "a pinned install never moves, whatever the switch says"
    CONFIG.clear()


def test_no_record_says_nothing():
    installed(None)
    s = api._update_state()
    assert s["never"] is False and s["auto"] is None and s["fix"] is None


if __name__ == "__main__":
    failed = 0
    try:
        for name, fn in list(globals().items()):
            if name.startswith("test_") and callable(fn):
                try:
                    fn()
                    print("ok  ", name)
                except Exception as e:
                    failed += 1
                    print("FAIL", name, e)
    finally:
        shutil.rmtree(HOME, ignore_errors=True)
    sys.exit(1 if failed else 0)
