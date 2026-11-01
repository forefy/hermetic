"""Nous Portal: what it billed per call is recorded, compared with its list prices, and its credits reach the popover.

Run inside Hermes' environment: bash ~/.hermes/hermes-agent/scripts/run-in-hermes-env python3 tests/test_nous.py
"""
import asyncio
import importlib.util
import json
import os
import sys
import tempfile
import time
import types
from pathlib import Path

HERE = Path(__file__).resolve().parent
HOME = Path(tempfile.mkdtemp(prefix="hermetic-nous-test-"))
os.environ["HERMES_HOME"] = str(HOME)  # a throwaway profile, never the real one

spec = importlib.util.spec_from_file_location("hermetic_init", HERE.parent / "__init__.py")
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)
spec = importlib.util.spec_from_file_location("plugin_api", HERE.parent / "dashboard" / "plugin_api.py")
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)
api._profile_home = lambda profile: ("default", HOME)

BILLS = HOME / "hermetic" / "nous-billed.jsonl"
PRICES = {"x/m": {"prompt": "0.000001", "completion": "0.000004", "input_cache_read": "0.0000001"}}
sys.modules["hermes_cli.models_pricing"] = types.SimpleNamespace(get_pricing_for_provider=lambda p, **k: PRICES if p == "nous" else {})


class Usage:
    """Like the OpenAI SDK's usage object: the Portal's own fields sit in model_extra."""
    prompt_tokens, completion_tokens = 1000, 100
    prompt_tokens_details = types.SimpleNamespace(cached_tokens=400)

    def __init__(self, cost, floor=False):
        self.model_extra = {"cost": cost, "cost_details": {"floor_applied": floor}}


def call(result, provider="nous", base_url="https://inference-api.nousresearch.com/v1"):
    return plugin._on_llm_execution(next_call=lambda req: result, request={}, api_request_id="r1", session_id="s1",
                                    provider=provider, base_url=base_url, model="x/m")


def rows():
    return [json.loads(l) for l in BILLS.read_text().splitlines()] if BILLS.exists() else []


def test_what_nous_billed_is_recorded_per_call():
    BILLS.unlink(missing_ok=True)
    result = types.SimpleNamespace(model="x/m", usage=Usage(0.00105))
    assert call(result) is result, "the call's result passes through untouched"
    r = rows()[-1]
    assert (r["model"], r["billed"], r["floor"], r["input"], r["output"], r["cache"], r["session"]) == ("x/m", 0.00105, 0, 1000, 100, 400, "s1")
    call(types.SimpleNamespace(model="x/m", usage={"prompt_tokens": 10, "completion_tokens": 1, "cost": 0.0001, "cost_details": {"floor_applied": True}}))
    assert rows()[-1]["floor"] == 1 and rows()[-1]["billed"] == 0.0001, "a plain dict usage works too"


def test_nothing_is_recorded_without_a_cost_or_off_nous():
    BILLS.unlink(missing_ok=True)
    call(types.SimpleNamespace(model="x/m", usage=types.SimpleNamespace(prompt_tokens=5, completion_tokens=1)))
    call(types.SimpleNamespace(model="x/m", usage=Usage(0.5)), provider="openrouter", base_url="https://openrouter.ai/api/v1")
    call(types.SimpleNamespace(model="x/m"))
    assert rows() == []


def test_billed_is_compared_with_list_prices_per_day():
    BILLS.unlink(missing_ok=True)
    call(types.SimpleNamespace(model="x/m", usage=Usage(0.00104)))
    call(types.SimpleNamespace(model="x/m", usage=Usage(0.002, floor=True)))
    call(types.SimpleNamespace(model="unpriced/m", usage=Usage(0.3)))
    days = asyncio.run(api.nous_billed(days=30, profile=None))["days"]
    d = days[time.strftime("%Y-%m-%d")]
    listed = 600e-6 + 400e-7 + 100 * 4e-6
    assert d["calls"] == 2 and d["floors"] == 1, "a model without a list price is left out"
    assert abs(d["billed"] - 0.00304) < 1e-12 and abs(d["list"] - 2 * listed) < 1e-12


def test_usable_credits_reach_the_popover_as_a_number():
    snap = types.SimpleNamespace(title="Nous credits", plan=None, details=["Total usable: $0.40"], unavailable_reason=None, windows=[])
    f = api._snapshot_fields(snap, {"window": None, "credits": 0.4})
    assert f["credits"] == 0.4 and f["windows"] == []
    assert api._snapshot_fields(snap)["credits"] is None, "other providers have no credits field"


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
