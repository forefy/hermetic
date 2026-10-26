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




def test_code_that_only_lists_a_place_is_a_read():
    code = 'import subprocess\ncmds = [\n    "ls -la /Library/LaunchDaemons/ 2>/dev/null",\n    "cat /etc/hosts",\n]\nfor c in cmds:\n    subprocess.run(c, shell=True)\n'
    assert api._HDR.code_op(code, "/Library/LaunchDaemons/") == "read"
    assert api._HDR.code_op('print(os.listdir("/Library/LaunchDaemons"))', "/Library/LaunchDaemons") == "read"
    assert api._HDR.code_op('data = open("/etc/hostname", "rb").read()', "/etc/hostname") == "read"
    assert api._HDR.code_op('data = open("/etc/hostname").read()', "/etc/hostname") == "read"
    assert api._HDR.code_op('f = open("/etc/hostname", mode)', "/etc/hostname") == "code"
    assert api._HDR.code_op('subprocess.run("plutil -p /Library/LaunchDaemons/a.plist | head", shell=True)', "/Library/LaunchDaemons/a.plist") == "read"


def test_code_that_may_write_stays_code():
    p = "/Library/LaunchDaemons/x.plist"
    for code in ['open("%s", "w").write(s)' % p, 'x = "%s"\nos.system("cp a " + x)' % p, 'x = "%s"\nPath(x).write_text(s)' % p,
                 'subprocess.run("echo hi > %s", shell=True)' % p, 'subprocess.run(["sudo", "launchctl", "load", "%s"])' % p,
                 'x = "%s"\nprint(x)' % p, 'subprocess.run("ls %s | xargs rm", shell=True)' % p,
                 'subprocess.run("ls /tmp", shell=True)\nshutil.copy("a", "%s")' % p, 'subprocess.run("find %s -delete", shell=True)' % p]:
        assert api._HDR.code_op(code, p) == "code", code
    hits = api._HDR.risky("execute_code", {"code": 'open("%s", "w")' % p})
    assert hits[0]["op"] == "code" and hits[0]["score"] == 100 and api._HDR.guarded({"why": hits[0]["why"], "op": "code"})
    hits = api._HDR.risky("execute_code", {"code": 'subprocess.run("ls -la /Library/LaunchDaemons/", shell=True)'})
    assert hits[0]["op"] == "read" and hits[0]["score"] == 30 and not api._HDR.guarded({"why": hits[0]["why"], "op": "read"})


def test_one_row_per_place_and_expected_reads_set_aside():
    job = "cron_4825824d6b1f_20261026_091119"
    hit = lambda op, sid, ts, tool="terminal", title="Endpoint threat hunt (bi-daily) \u00b7 Oct 26 09:16": {
        "path": "/Library/LaunchDaemons/", "op": op, "tool": tool, "chat": title, "ts": ts, "why": "starts programs at boot",
        "score": 30 if op == "read" else 100, "sid": sid, "snippet": "ls -la /Library/LaunchDaemons/"}
    rows, quiet = api._hdr_group_sensitive([hit("read", job, 1), hit("code", "s1", 2, "execute_code", "Some chat")], [])
    assert len(rows) == 1 and rows[0]["op"] == "code" and rows[0]["score"] == 100 and rows[0]["times"] == 2 and quiet == []
    assert rows[0]["ops"] == ["read", "code"] and rows[0]["sid"] == "s1"
    assert rows[0]["chats"] == ["Endpoint threat hunt (bi-daily)", "Some chat"], "a scheduled job is named once, not per run"
    marks = [{"path": "/Library/LaunchDaemons/", "key": "cron_4825824d6b1f"}]
    rows, quiet = api._hdr_group_sensitive([hit("read", job, 1), hit("read", "cron_4825824d6b1f_20261024_084536", 3)], marks)
    assert rows == [] and quiet[0]["times"] == 2 and quiet[0]["label"] == "Endpoint threat hunt (bi-daily)"
    rows, quiet = api._hdr_group_sensitive([hit("write", job, 1), hit("read", "other", 2, title="Other chat")], marks)
    assert rows[0]["times"] == 2 and rows[0]["op"] == "write" and quiet == [], "writes and other chats still show"
    assert api._hdr_job("abc", "A chat") == ("abc", "A chat")


def test_expected_route_saves_and_undoes():
    import asyncio
    import tempfile
    tmp = Path(tempfile.mkdtemp())
    api._profile_home = lambda profile: ("p", tmp)
    body = {"path": "/Library/LaunchDaemons/", "key": "cron_4825824d6b1f", "label": "Endpoint threat hunt (bi-daily)"}
    assert asyncio.run(api.hdr_expected(body, profile=None))["expected"] == 1
    assert asyncio.run(api.hdr_expected(body, profile=None))["expected"] == 1, "marking twice keeps one"
    assert api._hdr_expected_read(tmp)[0]["label"] == body["label"]
    assert asyncio.run(api.hdr_expected(dict(body, undo=True), profile=None))["expected"] == 0
    assert not asyncio.run(api.hdr_expected({"path": ""}, profile=None))["ok"]


def test_snippet_shows_the_line_that_named_the_place():
    code = "import os\nprint(os.listdir('%s/Library/LaunchAgents'))\n" % HOME
    assert api._hdr_snippet("execute_code", {"code": code}, "~/Library/LaunchAgents") == "print(os.listdir('%s/Library/LaunchAgents'))" % HOME
    assert api._hdr_snippet("read_file", {"path": "~/.ssh/config"}, "~/.ssh/config") == "read_file ~/.ssh/config"
    long = "echo a; " * 40 + "ls -la /Library/LaunchDaemons/; " + "echo b; " * 40
    snip = api._hdr_snippet("terminal", {"command": long}, "/Library/LaunchDaemons/")
    assert "/Library/LaunchDaemons/" in snip and snip.startswith("\u2026") and snip.endswith("\u2026") and len(snip) <= 202


def test_snippet_hides_typed_secrets():
    for cmd, secret in [('curl -H "Authorization: Bearer abcd1234efgh" -o ~/.ssh/x https://h.io', "abcd1234efgh"),
                        ("PASSWORD=hunter22secret cat ~/.ssh/config", "hunter22secret"),
                        ("export OPENAI_API_KEY=sk-proj-abcdefgh12345678; cat ~/.ssh/config", "sk-proj-abcdefgh12345678"),
                        ("echo ghp_abcdefghijklmnop123456 > ~/.config/gh/hosts.yml", "ghp_abcdefghijklmnop123456")]:
        path = "~/.config/gh/hosts.yml" if "gh/" in cmd else "~/.ssh/x" if "/x " in cmd else "~/.ssh/config"
        snip = api._hdr_snippet("terminal", {"command": cmd}, path)
        assert secret not in snip and "\u2022" in snip and path in snip, snip
    assert api._hdr_snippet("terminal", {"command": "ls -la ~/.ssh/"}, "~/.ssh/") == "ls -la ~/.ssh/"
    snip = api._hdr_snippet("terminal", {"command": "pw=$(grep SUDO_PASSWORD ~/.hermes/.env | cut -d= -f2-)"}, "~/.hermes/.env")
    assert "~/.hermes/.env" in snip and "$(grep" in snip, "paths and shell expansions are not secrets"


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
