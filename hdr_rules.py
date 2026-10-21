"""HDR's rules for what a tool call touches and how risky that is.

Shared by the HDR view (dashboard/plugin_api.py) and the guard hook (__init__.py), so both score a
call the same way. Pure functions, no Hermes imports.
"""
import json
import os
import re

URL = re.compile(r"https?://([A-Za-z0-9.-]+\.[A-Za-z]{2,})(?::\d+)?", re.I)
PATH = re.compile(r"(?<![\w.-])(~/[^\s'\"`|;&<>()]+|/(?:Users|tmp|private|etc|var|opt|Library|Applications|usr/local)[^\s'\"`|;&<>()]*)")
TLDS = {"com", "net", "org", "io", "dev", "ai", "app", "co", "me", "gov", "edu", "cloud", "tech", "xyz", "info", "biz",
        "sh", "so", "gg", "ly", "to", "page", "site", "online", "example", "test", "local", "internal"}

# Paths HDR watches, so it can tell when a tool call touched them. Hermetic never opens these.
SENSITIVE = [
    ("~/.ssh", "SSH keys", 70), ("~/.aws", "cloud keys", 70), ("~/.gnupg", "signing keys", 70),
    ("~/.config/gh", "GitHub login", 70), ("~/.netrc", "saved logins", 70), ("~/.docker/config.json", "registry logins", 70),
    ("~/.kube", "cluster access", 70), ("~/Library/Keychains", "keychain", 80),
    ("~/Library/LaunchAgents", "starts programs at login", 90), ("/Library/LaunchAgents", "starts programs at login", 90),
    ("/Library/LaunchDaemons", "starts programs at boot", 95),
    ("~/.zshrc", "runs in every shell", 85), ("~/.bashrc", "runs in every shell", 85), ("~/.zprofile", "runs in every shell", 85),
    ("~/.bash_profile", "runs in every shell", 85), ("~/.profile", "runs in every shell", 85),
    ("~/.hermes/auth.json", "Hermes logins", 75), ("~/.hermes/vault", "Hermes vault", 75), ("~/.hermes/.env", "Hermes keys", 75),
    ("/etc/", "system settings", 60),
]
CRED = {"SSH keys", "cloud keys", "signing keys", "GitHub login", "saved logins", "registry logins", "cluster access",
        "keychain", "Hermes logins", "Hermes vault", "Hermes keys", "keys file"}
FILE_TOOLS = {"read_file": "read", "search_files": "read", "write_file": "write", "patch": "write"}
STARTUP = {"starts programs at login", "starts programs at boot"}
# Writes that Hermes' own approval and file guards already ask about or refuse (tools/approval_detection.py,
# tools/file_tools_write_guards.py); the guard leaves those to Hermes.
HERMES_CHECKS_WRITES = {"SSH keys", "saved logins", "Hermes keys", "keys file", "runs in every shell", "system settings"}


def host_ok(h):
    last = h.rsplit(".", 1)[-1].lower()
    return len(last) == 2 or last in TLDS


def op(cmd, raw):
    """write when the command redirects into, edits, or copies onto this path; otherwise read."""
    q = re.escape(raw)
    if re.search(r"(>>?|\btee(\s+-a)?)\s*['\"]?" + q, cmd):
        return "write"
    if re.search(r"\b(rm|chmod|chown|touch|mkdir|truncate|sed\s+-i\S*)\b[^|;&\n]*" + q, cmd):
        return "write"
    for seg in re.split(r"[|;&\n]+", cmd):
        toks = seg.split()
        if toks and toks[0] in ("cp", "mv", "install", "rsync", "ln", "ditto") and toks[-1].strip("'\"") == raw:
            return "write"
    return "read"


def flatten(calls):
    """(name, args) for every tool call, opening the batch wrapper `tool_call`."""
    for t in calls if isinstance(calls, list) else []:
        if not isinstance(t, dict):
            continue
        f = t.get("function") if isinstance(t.get("function"), dict) else t
        name = f.get("name") or f.get("tool")
        args = f.get("arguments", f.get("args"))
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except Exception:
                args = {"_raw": args}
        args = args if isinstance(args, dict) else {}
        if name == "tool_call" and isinstance(args.get("calls"), list):
            yield from flatten(args["calls"])
            continue
        yield name, args


def tilde(p):
    home = os.path.expanduser("~")
    p = str(p or "").strip().rstrip(".,:")
    return "~" + p[len(home):] if p.startswith(home) else p


def sensitive(p):
    """(why, base score) when a path is one HDR watches, else None."""
    for prefix, why, base in SENSITIVE:
        if p == prefix or p.startswith(prefix.rstrip("/") + "/") or (prefix.endswith("/") and p.startswith(prefix)):
            return why, base
    if p.endswith("/.env") or p.endswith(".env") and "/" in p:
        return "keys file", 70
    return None


def score(why, base, how):
    """Writing (or code using the path) adds 10; reading keys keeps the base; other reads are 30."""
    return min(100, base + 10) if how in ("write", "code") else (base if why in CRED else 30)


def touches(name, args):
    """(paths with op, hosts) one tool call names."""
    paths, hosts = [], set()
    texts = []
    if name in FILE_TOOLS and args.get("path"):
        paths.append((tilde(args["path"]), FILE_TOOLS[name]))
    elif name == "terminal":
        cmd = str(args.get("command") or "")
        paths += [(tilde(m.group(1)), op(cmd, m.group(1))) for m in PATH.finditer(cmd)]
        if args.get("workdir"):
            paths.append((tilde(args["workdir"]), "workdir"))
        texts.append(cmd)
    elif name in ("execute_code", "browser_exec"):
        code = str(args.get("code") or "")
        paths += [(tilde(m.group(1)), "code") for m in PATH.finditer(code)]
        texts.append(code)
    else:
        texts += [v if isinstance(v, str) else json.dumps(v) for v in args.values() if isinstance(v, (str, list))]
    for t in texts:
        hosts.update(h.lower() for h in URL.findall(t) if host_ok(h))
    return paths, hosts


def guarded(hit):
    """Whether the guard acts on one touch: only what Hermes does not check itself. Reading keys and
    logins (Hermes checks no plain reads), writing startup items, and writing key places Hermes does
    not list; code that names such a place counts as both."""
    why, how = hit.get("why"), hit.get("op")
    if why in STARTUP:
        return how in ("write", "code")
    if why in CRED:
        return how in ("read", "code") or (how == "write" and why not in HERMES_CHECKS_WRITES)
    return False


def risky(name, args):
    """Every sensitive place one tool call touches, as {path, op, why, score}, highest score first."""
    out = []
    for p, how in touches(name, args if isinstance(args, dict) else {})[0]:
        s = sensitive(p)
        if s:
            out.append({"path": p, "op": how, "why": s[0], "score": score(s[0], s[1], how)})
    return sorted(out, key=lambda h: -h["score"])
