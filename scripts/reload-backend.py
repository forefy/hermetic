#!/usr/bin/env python3
"""Load backend changes (routes, hooks, guard rules) into a running Hermes without quitting the app.

Hermes 0.22 and later serve the desktop app from the gateway service. This asks Hermes to restart it with
`hermes gateway restart`, which refuses while a turn, scheduled job or background task is live, and
retries until Hermes is quiet. It also waits for any open guard question, which a restart would drop.

Older Hermes Desktop runs plugins inside its own backend. There this waits until no chat is working, in
every profile, then ends the backend, and the app starts a new one. Chats reconnect on their own either way.

The popover half (desktop/plugin.js) hot-reloads by itself and never needs this.

  python3 scripts/reload-backend.py           reload at the next quiet moment (waits up to 15 minutes)
  python3 scripts/reload-backend.py --check   only say what would be restarted and what it waits for
  python3 scripts/reload-backend.py --now     reload without waiting, interrupting live work

On older Hermes a chat counts as working when its activity or its latest message is under QUIET seconds
old, when its latest message still waits for an answer (yours, a tool result, or a reply that calls tools)
and is under OPEN seconds old, or when the backend still runs a tool command.
"""
import argparse
import glob
import json
import os
import shutil
import signal
import sqlite3
import subprocess
import sys
import time

QUIET = 90  # seconds without activity before a chat counts as idle (Hermes writes at least every 60)
OPEN = 900  # a turn still waiting for the model this long is taken as abandoned


def processes():
    out = subprocess.run(["ps", "-axo", "pid=,ppid=,command="], capture_output=True, text=True).stdout
    rows = []
    for line in out.splitlines():
        parts = line.split(None, 2)
        if len(parts) == 3:
            rows.append((int(parts[0]), int(parts[1]), parts[2]))
    return rows


def backends(rows):
    """An older desktop app's backend processes: Python children running `serve --host`."""
    return [pid for pid, _ppid, cmd in rows if "python" in cmd and " serve --host" in cmd]


def running_tools(rows, pids):
    """Commands a backend runs right now, besides its long-lived Python kernel."""
    return [cmd for _pid, ppid, cmd in rows if ppid in pids and "hermes_kernel_runner" not in cmd]


def homes(home):
    return [home] + sorted(glob.glob(os.path.join(home, "profiles", "*")))


def open_questions(home):
    """Guard questions still waiting for an answer, in every profile."""
    out, now = [], time.time()
    for h in homes(home):
        for f in glob.glob(os.path.join(h, "hermetic", "hdr", "asks", "*.json")):
            if f.endswith((".answer.json", ".outcome.json")):
                continue
            try:
                with open(f, encoding="utf-8") as fh:
                    a = json.load(fh)
            except (OSError, ValueError):
                continue
            if float(a.get("until") or 0) > now and not os.path.exists(f[:-5] + ".answer.json"):
                out.append(f"guard question about {a.get('path')}")
    return out


def working_chats(home):
    busy, now = [], time.time()
    for h in homes(home):
        path = os.path.join(h, "state.db")
        if not os.path.exists(path):
            continue
        try:
            db = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)
            rows = db.execute(
                "SELECT s.title, s.last_activity_at, s.last_activity_description, m.role, m.tool_calls, m.timestamp "
                "FROM sessions s JOIN messages m ON m.id = (SELECT id FROM messages WHERE session_id = s.id "
                "ORDER BY timestamp DESC, id DESC LIMIT 1) "
                "WHERE s.ended_at IS NULL AND (s.last_activity_at > ? OR m.timestamp > ?)",
                (now - QUIET, now - OPEN)).fetchall()
            db.close()
        except sqlite3.Error:
            continue
        for title, at, desc, role, calls, ts in rows:
            waiting = role in ("user", "tool") or (role == "assistant" and calls not in (None, "", "[]"))
            last = max(at or 0, ts or 0)
            if now - last < QUIET or waiting:
                why = "waiting for the model" if waiting and now - last >= QUIET else desc or "active"
                busy.append(f"{title or 'untitled'} ({why}, {int(now - last)}s ago)")
    return busy


def hermes_cli(home):
    found = shutil.which("hermes")
    local = os.path.join(home, "hermes-agent", ".hermes", "bin", "hermes")
    return found or (local if os.path.exists(local) else None)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--check", action="store_true", help="only report, change nothing")
    ap.add_argument("--now", action="store_true", help="reload without waiting, interrupting live work")
    ap.add_argument("--wait", type=int, default=900, help="seconds to wait at most (default 900)")
    args = ap.parse_args()
    home = os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes")
    old = backends(processes())
    cli = None if old else hermes_cli(home)
    if not old and not cli:
        sys.exit("No Hermes desktop backend is running and the hermes command was not found.")
    what = "the desktop backend" if old else "the Hermes gateway"

    deadline, said = time.time() + args.wait, None
    while True:
        rows = processes()
        busy = open_questions(home)
        if old:
            pids = backends(rows)
            if not pids:
                sys.exit("The desktop backend is gone, nothing to reload.")
            busy += working_chats(home) + [f"tool command: {c[:80]}" for c in running_tools(rows, set(pids))]
        if args.check:
            print(f"restarts {what}" + (f" ({', '.join(map(str, pids))})" if old else ""))
            print("waiting for: " + "; ".join(busy) if busy else "nothing to wait for" + ("" if old else " here, Hermes checks for live work itself"))
            return
        if not busy or args.now:
            if old:
                break
            run = subprocess.run([cli, "gateway", "restart"] + (["--yes"] if args.now else []),
                                 stdin=subprocess.DEVNULL, capture_output=True, text=True)
            if run.returncode == 0:
                print("Hermes restarted its gateway, which now runs the current plugin code")
                return
            busy = [(run.stdout + run.stderr).strip().splitlines()[-1][:160] if (run.stdout + run.stderr).strip() else "Hermes refused"]
        if time.time() > deadline:
            sys.exit("Still busy after waiting, nothing restarted: " + "; ".join(busy))
        if busy != said:
            print("waiting for: " + "; ".join(busy), flush=True)
            said = busy
        time.sleep(15)

    for pid in pids:
        os.kill(pid, signal.SIGTERM)
    print(f"ended backend {', '.join(map(str, pids))}, waiting for the app to start a new one", flush=True)
    for _ in range(90):
        time.sleep(1)
        fresh = [p for p in backends(processes()) if p not in pids]
        if fresh:
            print(f"new backend {', '.join(map(str, fresh))} is running the current plugin code")
            return
    sys.exit("The app did not start a new backend within 90 seconds; open Hermes to check it.")


if __name__ == "__main__":
    main()
