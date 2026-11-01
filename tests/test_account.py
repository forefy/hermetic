"""Hermes' account report (plan windows, credits) reaches the popover as fields, never as a credential,
with the OpenRouter workspace and guardrail budgets the report leaves out.

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


KEY = {"limit": None, "budgets": [
    {"scope": "workspace", "budget_id": "b1", "limit_usd": 50, "spend_usd": 47.5, "reset_interval": "daily", "resets_at": "2026-11-02T00:00:00.000Z"},
    {"scope": "workspace_default_member", "guardrail_id": "g1", "limit_usd": 20, "spend_usd": 1, "reset_interval": "weekly", "resets_at": "2026-11-09T00:00:00.000Z"},
    {"scope": "workspace", "limit_usd": 900, "spend_usd": 12, "reset_interval": "lifetime", "resets_at": "2099-01-01T00:00:00.000Z"},
    {"scope": "key_limit", "limit_usd": 200, "spend_usd": 10, "reset_interval": "monthly"},
    {"scope": "workspace", "limit_usd": 0, "spend_usd": 0, "reset_interval": "monthly"},
    {"scope": "workspace", "limit_usd": float("nan"), "spend_usd": 1, "reset_interval": "monthly"},
    "not a budget"]}


def test_openrouter_budgets_become_fields():
    b = api._openrouter_budgets(KEY)
    assert [x["label"] for x in b] == ["Workspace daily budget", "Your weekly budget", "Workspace total budget"], \
        "the key's own cap is Hermes' to report, and an unset or broken limit is left out"
    assert b[0] == {"label": "Workspace daily budget", "interval": "daily", "limit": 50.0, "spent": 47.5, "reset_at": "2026-11-02T00:00:00.000Z"}
    assert b[2]["reset_at"] is None, "a lifetime budget never resets"
    assert api._openrouter_budgets({"limit": 10}) == [] and api._openrouter_budgets({"budgets": "x"}) == []


def test_openrouter_budgets_fail_quietly_without_a_key():
    saved = api._aai_runtime
    api._aai_runtime = lambda cfg=None: (_ for _ in ()).throw(RuntimeError("no key"))
    try:
        assert api._openrouter_budgets() == []
    finally:
        api._aai_runtime = saved


def test_budgets_reach_the_popover():
    snap = AccountUsageSnapshot(provider="openrouter", source="credits_api", fetched_at=RESET, title="Account limits", windows=(), details=("Credits balance: $5.00",))
    f = api._snapshot_fields(snap, {"budgets": api._openrouter_budgets(KEY)})
    assert len(f["budgets"]) == 3 and f["windows"] == []
    assert api._snapshot_fields(snap)["budgets"] == []


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
