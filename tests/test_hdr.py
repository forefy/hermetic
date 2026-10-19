"""HDR detection rules. Run with the Python that runs Hermes (it provides FastAPI):

    python tests/test_hdr.py
"""
import importlib.util
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("plugin_api", HERE.parent / "dashboard" / "plugin_api.py")
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)
HOME = os.path.expanduser("~")


def test_write_only_when_the_path_is_the_target():
    assert api._hdr_op("echo x > ~/.zshrc", "~/.zshrc") == "write"
    assert api._hdr_op("cat ~/.ssh/config 2>/dev/null", "~/.ssh/config") == "read"
    assert api._hdr_op("cp ./a.plist ~/Library/LaunchAgents/a.plist", "~/Library/LaunchAgents/a.plist") == "write"
    assert api._hdr_op("cp ~/Library/LaunchAgents/a.plist /tmp/a.plist", "~/Library/LaunchAgents/a.plist") == "read"
    assert api._hdr_op("sed -i '' s/a/b/ ~/.bashrc", "~/.bashrc") == "write"
    assert api._hdr_op("ls ~/Library/LaunchAgents/", "~/Library/LaunchAgents/") == "read"


def test_sensitive_places():
    assert api._hdr_sensitive("~/.ssh/id_ed25519")[0] == "SSH keys"
    assert api._hdr_sensitive("~/Library/LaunchAgents/x.plist")[0] == "starts programs at login"
    assert api._hdr_sensitive("~/projects/app/.env")[0] == "keys file"
    assert api._hdr_sensitive("~/projects/app/main.py") is None


def test_hosts_need_a_real_top_level_domain():
    assert api._hdr_host_ok("api.github.com")
    assert api._hdr_host_ok("example.co.il")
    assert not api._hdr_host_ok("backend.internalname")


def test_roots_and_home():
    assert api._hdr_tilde(HOME + "/projects/x") == "~/projects/x"
    assert api._hdr_root("~/.hermes/skills/a/SKILL.md") == "~/.hermes"
    assert api._hdr_root("~/Desktop/work/repo/file.py") == "~/Desktop/work"
    assert api._hdr_root("/tmp/build/out") == "/tmp"


def test_batched_calls_are_opened():
    calls = [{"function": {"name": "tool_call", "arguments": '{"calls": [{"name": "read_file", "arguments": {"path": "/tmp/a"}}]}'}}]
    assert list(api._hdr_flatten(calls)) == [("read_file", {"path": "/tmp/a"})]


def test_terminal_paths_and_hosts():
    paths, hosts = api._hdr_touches("terminal", {"command": "curl -s https://api.github.com/x > /tmp/out.json", "workdir": HOME + "/projects"})
    assert ("/tmp/out.json", "write") in paths and ("~/projects", "workdir") in paths
    assert hosts == {"api.github.com"}


def test_posture_flags_approvals_off():
    rows = {r["key"]: r for r in api._hdr_posture({"approvals": {"mode": "off"}, "terminal": {"backend": "docker"}})}
    assert rows["approvals"]["tone"] == "bad"
    assert rows["terminal"]["tone"] == "ok"
    assert rows["inbound"]["tone"] == "ok"


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
