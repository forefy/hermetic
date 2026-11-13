"""A throwaway Hermes home for a test, never the real one.

Hermes treats a home inside its default folder as that default one, and the temp folder can live there
(TMPDIR under ~/.hermes). So the home is checked, and if Hermes would not use it, it is made in the user's
home folder instead."""
import os
import shutil
import tempfile
from pathlib import Path


def throwaway_home(prefix):
    from hermes_constants import get_default_hermes_root
    for base in (None, Path.home()):
        home = Path(tempfile.mkdtemp(prefix=prefix, dir=base))
        os.environ["HERMES_HOME"] = str(home)
        if Path(get_default_hermes_root()).resolve() == home.resolve():
            return home
        shutil.rmtree(home, ignore_errors=True)
    raise SystemExit("These tests need a folder outside the Hermes home, and none was found.")
