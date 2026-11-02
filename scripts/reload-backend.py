#!/usr/bin/env python3
"""Load backend changes (routes, hooks, guard rules) into a running Hermes Desktop without quitting it.

Waits until no chat is working, in every profile, then ends the app's backend process. The app's
supervisor starts a new one at once, which imports the plugin code fresh; chats reconnect on their own.
The popover half (desktop/plugin.js) hot-reloads by itself and never needs this.

  python3 scripts/reload-backend.py           wait for a quiet moment (up to 15 minutes), then reload
  python3 scripts/reload-backend.py --check   only say whether Hermes is busy and which backends run
  python3 scripts/reload-backend.py --now     reload without waiting

A chat counts as working when its activity or its latest message is under QUIET seconds old, when its
latest message still waits for an answer (yours, a tool result, or a reply that calls tools) and is under
OPEN seconds old, or when a backend still runs a tool command.
"""
import argparse
import glob
import os
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
    """The desktop app's backend processes: Python children running `serve --host`."""
    return [pid for pid, _ppid, cmd in rows if "python" in cmd and " serve --host" in cmd]


def running_tools(rows, pids):
    """Commands a backend runs right now, besides its long-lived Python kernel."""
    return [cmd for _pid, ppid, cmd in rows if ppid in pids and "hermes_kernel_runner" not in cmd]


def working_chats(home):
    dbs = [os.path.join(home, "state.db")] + glob.glob(os.path.join(home, "profiles", "*", "state.db"))
    busy, now = [], time.time()
    for path in dbs:
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


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--check", action="store_true", help="only report, change nothing")
    ap.add_argument("--now", action="store_true", help="reload without waiting for a quiet moment")
    ap.add_argument("--wait", type=int, default=900, help="seconds to wait for a quiet moment (default 900)")
    args = ap.parse_args()
    home = os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes")

    deadline, said = time.time() + args.wait, None
    while True:
        rows = processes()
        pids = backends(rows)
        if not pids:
            sys.exit("No Hermes Desktop backend is running.")
        busy = working_chats(home) + [f"tool command: {c[:80]}" for c in running_tools(rows, set(pids))]
        if args.check:
            print(f"backends: {', '.join(map(str, pids))}")
            print("busy: " + "; ".join(busy) if busy else "idle")
            return
        if not busy or args.now:
            break
        if time.time() > deadline:
            sys.exit("Still busy after waiting, nothing restarted: " + "; ".join(busy))
        if busy != said:
            print("waiting for: " + "; ".join(busy), flush=True)
            said = busy
        time.sleep(10)

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
