"""HDR's rules for what a tool call touches and how risky that is.

Shared by the HDR view (dashboard/plugin_api.py) and the guard hook (__init__.py), so both score a
call the same way. Pure functions, no Hermes imports.
"""
import fnmatch
import functools
import json
import os
import re

URL = re.compile(r"https?://([A-Za-z0-9.-]+\.[A-Za-z]{2,})(?::\d+)?", re.I)
PATH = re.compile(r"(?<![\w.-])(~/[^\s'\"`|;&<>()]+|/(?:Users|home|root|tmp|private|etc|var|opt|Library|Applications|usr/local)[^\s'\"`|;&<>()]*)")
# The home folder however a command or code writes it ($HOME, ${HOME}, ${HOME:-x}, ~name/), and any user's
# home folder, all read as ~ so `cat $HOME/.ssh/id_rsa` is the same read as `cat ~/.ssh/id_rsa`
HOME_VAR = re.compile(r"\$\{HOME(?::?[-=+?][^}]*)?\}|\$HOME(?!\w)")
NAMED_HOME = re.compile(r"(?<![\w.-])~[A-Za-z_][\w.-]*/")
ANY_HOME = re.compile(r"^/(?:Users|home)/[^/]+(?=/|$)|^/(?:var/)?root(?=/|$)")
# Key places by their own names, wherever they sit in a command or code: a path built in pieces
# (os.path.join(home, ".ssh"), a variable, a relative path from the home folder) still names them
KEY_PLACES = re.compile(r"(?<![\w-])(\.ssh|\.aws|\.gnupg|\.kube|\.netrc|\.config/gh|\.docker/config\.json|Library/Keychains|"
                        r"\.hermes/(?:auth\.json|vault|\.env))(?![\w-])")
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


# Fixed patterns, with the path checked as a plain string after each match: a pattern built per path
# missed re's cache on every call and made the first HDR load take seconds.
REDIRECT = re.compile(r"(>>?|\btee(\s+-a)?)\s*['\"]?")
EDITS = re.compile(r"\b(rm|chmod|chown|touch|mkdir|truncate|sed\s+-i\S*)\b")
SEP = re.compile(r"[|;&\n]")
SEPS = re.compile(r"[|;&\n]+")
ESCAPED = re.compile(r"\\(.)")


@functools.lru_cache(maxsize=32)
def _writes_of(cmd):
    """Where a command writes: (where each redirect's target starts, each editing command's end with
    the end of its part of the line, the last word of each copy). Kept per command, since a command
    is asked about once for every path it names."""
    edits = []
    for m in EDITS.finditer(cmd):
        stop = SEP.search(cmd, m.end())
        edits.append((m.end(), None if stop is None else stop.start()))
    copies = set()
    for seg in SEPS.split(cmd):
        toks = seg.split()
        if toks and toks[0] in ("cp", "mv", "install", "rsync", "ln", "ditto"):
            copies.add(toks[-1].strip("'\""))
    return [m.end() for m in REDIRECT.finditer(cmd)], edits, copies


def op(cmd, raw):
    """write when the command redirects into, edits, or copies onto this path; otherwise read."""
    redirects, edits, copies = _writes_of(cmd)
    if any(cmd.startswith(raw, end) for end in redirects):
        return "write"
    for end, stop in edits:
        at = cmd.find(raw, end)
        if at >= 0 and (stop is None or at <= stop):
            return "write"
    return "write" if raw in copies else "read"


# Code that only looks at a path: every line naming it runs one of these read-only commands (or a read-only
# Python call), and nothing anywhere in the code could write. Anything else stays "code", which counts as a write.
READ_CMD = re.compile(r"^(sudo\s+)?(ls|cat|head|tail|stat|file|wc|grep|egrep|rg|find|readlink|du|md5|shasum|mdls|test|\[|"
                      r"plutil\s+-(p|lint)|defaults\s+read|xattr\s+-l|codesign\s+-d\w*|launchctl\s+(list|print)|crontab\s+-l)(\s|$)")
FILTERS = re.compile(r"^(grep|egrep|head|tail|sort|uniq|wc|cut|awk|tr|column|less|cat)(\s|$)")
READ_CALL = re.compile(r"(os\.listdir|os\.scandir|os\.walk|os\.path\.\w+|glob\.glob|\.read_text|\.read_bytes|\.exists|"
                       r"\.iterdir|\.is_file|\.is_dir|\.stat)\(|\bopen\([^,()]*(,\s*['\"]r[bt]?['\"])?\s*\)")
WRITES = re.compile(r"open\([^)]*['\"][wax]|\.write_(text|bytes)\(|\.(unlink|rename|replace|symlink_to|hardlink_to|chmod|mkdir|touch|rmdir|write)\(|"
                    r"\bshutil\.|\bos\.(remove|unlink|rename|replace|makedirs|mkdir|chmod|chown|symlink|link|rmdir|truncate)\b|plistlib\.dump|"
                    r"\b(rm|cp|mv|touch|chmod|chown|ln|install|ditto|rsync|tee|truncate|mkdir|rmdir|unlink|dd)\s|sed\s+-i|"
                    r"launchctl\s+(load|unload|bootstrap|bootout|enable|disable|submit|remove|kickstart)|defaults\s+(write|delete|import)|"
                    r"plutil\s+-(convert|replace|insert|remove|create)|>>|-delete\b|-exec\b|osascript|\bcurl\b[^\n]*\s-o|\bwget\b|"
                    r"(?<![-=<>!])>\s*['\"]?[~/$]")
QUIET = re.compile(r"\d?&?>\s*/dev/null|\d>&\d")
LIT = re.compile(r"[rRfFbBuU]{0,2}(['\"])(.*?)\1")


def _read_only_cmd(cmd):
    segs = [x.strip() for x in re.split(r"\|\||&&|[|;]", cmd) if x.strip()]
    return bool(segs) and bool(READ_CMD.match(segs[0])) and all(READ_CMD.match(x) or FILTERS.match(x) for x in segs[1:])


@functools.lru_cache(maxsize=32)
def _code_lines(code):
    """The lines of some code with quiet redirects dropped, or None when anything in it could write."""
    clean = QUIET.sub(" ", code)
    return None if WRITES.search(clean) else clean.splitlines()


def code_op(code, raw):
    """read when the code only lists or reads this path with known read-only commands and writes nothing
    anywhere; otherwise code (treated as a write: what code does with a path can't be told for sure)."""
    clean = _code_lines(str(code or ""))
    if clean is None:
        return "code"
    lines = [ln for ln in clean if raw in ln]
    for ln in lines:
        lits = [b for _q, b in LIT.findall(ln) if raw in b]
        if not lits:
            if not READ_CALL.search(ln):
                return "code"
        for b in lits:
            b = b.strip()
            if b.startswith(raw):  # the literal is the path itself: fine only when the line reads it
                if not READ_CALL.search(ln):
                    return "code"
            elif not _read_only_cmd(b):
                return "code"
    return "read" if lines else "code"


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


def home_text(t):
    """Text with the home folder written as ~, however it was named."""
    if "HOME" in t:
        t = HOME_VAR.sub("~", t)
    return NAMED_HOME.sub("~/", t) if "~" in t else t


def shell_text(cmd):
    """A command as the shell reads its paths: backslashes and quotes dropped, the home folder as ~."""
    if "\\" in cmd:
        cmd = ESCAPED.sub(r"\1", cmd)
    return home_text(cmd.replace("'", "").replace('"', ""))


def _glob_place(p):
    """The watched place a wildcard path could open (~/.s*/id_rsa, ~/.*/credentials), compared part by part."""
    parts = p.split("/")
    for prefix, why, base in SENSITIVE:
        want = prefix.rstrip("/").split("/")
        if len(parts) >= len(want) and all(fnmatch.fnmatchcase(w, g) for w, g in zip(want, parts)):
            return why, base
    return None


# every watched place without its last slash: a path that starts with none of them is in none of them
_WATCHED = tuple(prefix.rstrip("/") for prefix, _why, _base in SENSITIVE)


def sensitive(p):
    """(why, base score) when a path is one HDR watches, else None."""
    if p.startswith("/"):
        p = ANY_HOME.sub("~", p, count=1)
    if p.startswith(_WATCHED):
        for prefix, why, base in SENSITIVE:
            if p == prefix or p.startswith(prefix.rstrip("/") + "/") or (prefix.endswith("/") and p.startswith(prefix)):
                return why, base
    if any(c in p for c in "*?["):
        hit = _glob_place(p)
        if hit:
            return hit
    if p.endswith("/.env") or p.endswith(".env") and "/" in p:
        return "keys file", 70
    return None


def score(why, base, how):
    """Writing (or code using the path in a way that may write) adds 10; reading keys keeps the base; other reads are 30."""
    return min(100, base + 10) if how in ("write", "code") else (base if why in CRED else 30)


def hosts(name, args):
    """The hosts one tool call names."""
    if name in FILE_TOOLS and args.get("path"):
        texts = []
    elif name == "terminal":
        texts = [str(args.get("command") or "")]
    elif name in ("execute_code", "browser_exec"):
        texts = [str(args.get("code") or "")]
    else:
        texts = [v if isinstance(v, str) else json.dumps(v) for v in args.values() if isinstance(v, (str, list))]
    return {h.lower() for t in texts for h in URL.findall(t) if host_ok(h)}


def paths(name, args):
    """The paths one tool call names, each with what the call does to it."""
    out = []
    named, how_of = "", None
    if name in FILE_TOOLS and args.get("path"):
        named = home_text(str(args["path"]))
        out.append((tilde(named), FILE_TOOLS[name]))
        how_of = lambda raw: FILE_TOOLS[name]
    elif name == "terminal":
        named = shell_text(str(args.get("command") or ""))
        out += [(tilde(m.group(1)), op(named, m.group(1))) for m in PATH.finditer(named)]
        if args.get("workdir"):
            out.append((tilde(home_text(str(args["workdir"]))), "workdir"))
        how_of = lambda raw: op(named, raw)
    elif name in ("execute_code", "browser_exec"):
        named = home_text(str(args.get("code") or ""))
        out += [(tilde(m.group(1)), code_op(named, m.group(1))) for m in PATH.finditer(named)]
        how_of = lambda raw: code_op(named, raw)
    # a key place named only in pieces or relative to the home folder: the place itself, once
    seen = {folder_of(ANY_HOME.sub("~", p, count=1)) for p, _ in out if sensitive(p)}
    for m in KEY_PLACES.finditer(named):
        place = "~/" + m.group(1)
        if place not in seen:
            seen.add(place)
            out.append((place, how_of(m.group(1))))
    return out


def touches(name, args):
    """(paths with op, hosts) one tool call names."""
    return paths(name, args), hosts(name, args)


def guarded(hit):
    """Whether the guard acts on one touch: only what Hermes does not check itself. Reading keys and
    logins (Hermes checks no plain reads), writing startup items, and writing key places Hermes does
    not list; code that names such a place counts as both, unless it only reads it (code_op)."""
    why, how = hit.get("why"), hit.get("op")
    if why in STARTUP:
        return how in ("write", "code")
    if why in CRED:
        return how in ("read", "code") or (how == "write" and why not in HERMES_CHECKS_WRITES)
    return False


def kind(why):
    """What a guarded place is, for rules that cover a whole kind: 'startup' or 'keys'."""
    return "startup" if why in STARTUP else "keys" if why in CRED else None


def folder_of(p):
    """The watched place a path belongs to (~/.ssh, ~/.aws, a LaunchAgents folder), or its own folder."""
    for prefix, _why, _base in SENSITIVE:
        if p == prefix or p.startswith(prefix.rstrip("/") + "/"):
            return prefix.rstrip("/")
    return os.path.dirname(p) or p


def rule_covers(rule, hit, session_id=""):
    """Whether one saved guard rule answers this touch. Scope 'file', 'folder' or 'kind'; a rule saved
    for one chat only applies in that chat."""
    if rule.get("session_id") and rule["session_id"] != session_id:
        return False
    if rule.get("op") != hit.get("op"):
        return False
    scope, path = rule.get("scope"), hit.get("path") or ""
    if scope == "file":
        return path == rule.get("path")
    if scope == "folder":
        f = str(rule.get("folder") or "")
        return bool(f) and (path == f or path.startswith(f.rstrip("/") + "/"))
    if scope == "kind":
        return kind(hit.get("why")) == rule.get("kind") and rule.get("kind") is not None
    return False


def risky(name, args):
    """Every sensitive place one tool call touches, as {path, op, why, score}, highest score first."""
    out = []
    for p, how in paths(name, args if isinstance(args, dict) else {}):
        s = sensitive(p)
        if s:
            out.append({"path": p, "op": how, "why": s[0], "score": score(s[0], s[1], how)})
    return sorted(out, key=lambda h: -h["score"])
