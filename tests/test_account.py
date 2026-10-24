"""Hermes' account report (plan windows, credits) reaches the popover as fields, never as a credential.

Run inside Hermes' environment: bash ~/.hermes/hermes-agent/scripts/run-in-hermes-env python3 tests/test_account.py
"""
import importlib.util
import sys
from datetime import datetime, timezone
from pathlib import Path

from agent.account_usage import AccountUsageSnapshot, AccountUsageWindow

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("plugin_api", HERE.parent / "dashboard" / "plugin_api.py")
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)

RESET = datetime(2026, 10, 24, 14, 30, tzinfo=timezone.utc)


def test_plan_windows_become_fields():
    snap = AccountUsageSnapshot(provider="openai-codex", source="usage_api", fetched_at=RESET, plan="Plus",
                                windows=(AccountUsageWindow(label="Session", used_percent=62.0, reset_at=RESET),
                                         AccountUsageWindow(label="Opus week", used_percent=10.0, scope="model")),
                                details=("Credits: $4.00",))
    f = api._snapshot_fields(snap)
    assert f["plan"] == "Plus" and f["details"] == ["Credits: $4.00"] and f["unavailable"] is None
    assert f["windows"][0] == {"label": "Session", "used_percent": 62.0, "reset_at": "2026-10-24T14:30:00+00:00", "detail": None, "scope": "account"}
    assert f["windows"][1]["scope"] == "model" and f["windows"][1]["reset_at"] is None


def test_no_report_is_none():
    assert api._snapshot_fields(None) is None


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
