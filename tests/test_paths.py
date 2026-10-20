"""Skill names and version ids from requests never leave Hermetic's own folders.

Run inside Hermes' environment: bash ~/.hermes/hermes-agent/scripts/run-in-hermes-env python3 tests/test_paths.py
"""
import importlib.util
import os
import shutil
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
HOME = Path(tempfile.mkdtemp(prefix="hermetic-paths-test-"))
os.environ["HERMES_HOME"] = str(HOME)  # a throwaway profile, never the real one

spec = importlib.util.spec_from_file_location("plugin_api", HERE.parent / "dashboard" / "plugin_api.py")
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)

SKILL = HOME / "skills" / "notes" / "SKILL.md"
SKILL.parent.mkdir(parents=True)
SKILL.write_text("---\nname: notes\n---\nTake notes.\n")
SECRET = HOME / "elsewhere" / "cand-00000000aa.md"  # any readable .md with an id-shaped name
SECRET.parent.mkdir()
SECRET.write_text("not a skill")
CAND = api._data_dir(HOME) / "candidates" / "notes" / "cand-0123456789.md"
CAND.parent.mkdir(parents=True)
CAND.write_text("---\nname: notes\n---\nTake better notes.\n")


def test_generated_ids_still_work():
    assert api._aai_version_text(HOME, "notes", "cand-0123456789").endswith("Take better notes.\n")
    assert api._aai_version_text(HOME, "notes", "current").endswith("Take notes.\n")


def test_a_skill_name_cannot_point_at_another_folder():
    # the reviewer's case: candidates/<skill>/<id>.md with skill = a path out of Hermetic's folder
    walk = os.path.relpath(SECRET.parent, CAND.parent.parent)
    assert api._aai_version_text(HOME, walk, "cand-00000000aa") is None


def test_a_version_id_cannot_walk_out():
    for bad in ("cand-../../../elsewhere", "cand-0123456789/../x", "*", "../x", "cand-00000000aa/.."):
        assert api._aai_version_text(HOME, "notes", bad) is None, bad


def test_a_skill_name_cannot_walk_out():
    for bad in ("../notes", "notes/../../x", ".hidden", "", None, "a" * 200):
        assert api._aai_version_text(HOME, bad, "current") is None, bad
        assert api._aai_saved_versions(HOME, bad) == [], bad
    try:
        api._aai_keep_current(HOME, "../x", SKILL)
        raise AssertionError("expected a refusal")
    except ValueError:
        pass


def test_ship_refuses_a_crafted_candidate():
    import asyncio
    walk = os.path.relpath(SECRET.parent, CAND.parent.parent)
    r = asyncio.run(api.aai_ship({"skill": walk, "candidate": "cand-00000000aa"}))
    assert r["ok"] is False
    assert SKILL.read_text().endswith("Take notes.\n"), "the skill was left alone"


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
