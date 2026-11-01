"""Hermetic's own model calls go through Hermes: ctx.llm for helpers, the secret scope for replay keys.

Run with the Python that runs Hermes: python tests/test_credentials.py
"""
import importlib.util
import json
import sys
import types
from pathlib import Path

HERE = Path(__file__).resolve().parent

# Stand-ins for Hermes' plugin LLM lane and secret scope, so no real model or key is touched.
calls = []
scope = {"depth": 0, "key": "sk-or-test"}


class PluginLlmTrustError(Exception):
    pass


class _Usage:
    cost_usd, input_tokens, output_tokens = 0.002, 120, 30


class _Result:
    text, provider, model, usage = '{"verdict": "pass"}', "openrouter", "active/model", _Usage()


class PluginLlm:
    allow_model = False

    def __init__(self, plugin_id):
        assert plugin_id == "hermetic"

    def _call(self, kind, kw):
        calls.append((kind, kw, scope["depth"]))
        if "model" in kw and not PluginLlm.allow_model:
            raise PluginLlmTrustError("model override not allowed")
        return _Result()

    def complete(self, **kw):
        return self._call("complete", kw)

    def complete_structured(self, **kw):
        return self._call("structured", kw)


def _set_scope(*a, **k):
    scope["depth"] += 1
    return "tok"


def _reset_scope(tok):
    scope["depth"] -= 1


sys.modules["agent.plugin_llm"] = types.SimpleNamespace(PluginLlm=PluginLlm, PluginLlmTrustError=PluginLlmTrustError)
sys.modules["agent.secret_scope"] = types.SimpleNamespace(
    build_profile_secret_scope=lambda home: {}, set_secret_scope=_set_scope, reset_secret_scope=_reset_scope,
    get_secret=lambda name: scope["key"] if name == "OPENROUTER_API_KEY" and scope["depth"] else None)

spec = importlib.util.spec_from_file_location("plugin_api", HERE.parent / "dashboard" / "plugin_api.py")
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)

MSGS = [{"role": "system", "content": "Grade it."}, {"role": "user", "content": "the reply"}]


def test_helper_json_goes_through_ctx_llm():
    calls.clear()
    PluginLlm.allow_model = True
    out = api._aai_helper("judge/model", MSGS, json_mode=True, purpose="hermetic.judge")
    kind, kw, depth = calls[-1]
    assert kind == "structured" and kw["model"] == "judge/model" and kw["json_mode"]
    assert kw["instructions"] == "Grade it." and kw["input"][0]["text"] == "the reply"
    assert depth == 1, "the call runs inside the profile's secret scope"
    assert out["content"] == '{"verdict": "pass"}' and out["cost"] == 0.002 and out["input"] == 120
    assert scope["depth"] == 0, "the scope is released afterwards"


def test_helper_falls_back_to_active_model_when_override_is_not_allowed():
    calls.clear()
    PluginLlm.allow_model = False
    out = api._aai_helper("judge/model", MSGS)
    assert [c[0] for c in calls] == ["complete", "complete"]
    assert "model" in calls[0][1] and "model" not in calls[1][1]
    assert out["model"] == "active/model"


def test_replay_key_comes_from_the_secret_scope():
    scope["key"] = "sk-or-test"
    rt = api._aai_runtime({"model": {"provider": "openrouter"}})
    assert rt["api_key"] == "sk-or-test" and rt["base_url"] == "https://openrouter.ai/api/v1"
    assert scope["depth"] == 0


def test_replay_without_key_says_so():
    scope["key"] = None
    try:
        api._aai_runtime({"model": {"provider": "openrouter"}})
        raise AssertionError("expected an error without a key")
    except RuntimeError as exc:
        assert "OPENROUTER_API_KEY" in str(exc)
    finally:
        scope["key"] = "sk-or-test"


class _Resp:
    def __init__(self, body):
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def read(self):
        return json.dumps(self.body).encode()


def _on_nous(fn):
    """Run fn with the profile's main model on Nous Portal, Hermes' Nous sign-in, prices and tags stubbed."""
    sent = []
    saved = {k: sys.modules.get(k) for k in ("hermes_cli.runtime_provider", "agent.portal_tags", "hermes_cli.models_pricing")}
    load, urlopen = api._aai_load_cfg, api._aai_urlreq.urlopen
    sys.modules["hermes_cli.runtime_provider"] = types.SimpleNamespace(
        resolve_runtime_provider=lambda requested=None, **k: {"api_key": "nous-jwt", "base_url": "https://inference-api.nousresearch.com/v1/"} if requested == "nous" else {})
    sys.modules["agent.portal_tags"] = types.SimpleNamespace(nous_portal_tags=lambda: ["product=hermes-agent"])
    sys.modules["hermes_cli.models_pricing"] = types.SimpleNamespace(
        get_pricing_for_provider=lambda p: {"x/m": {"prompt": "0.000001", "completion": "0.000004", "input_cache_read": "0.0000001"}} if p == "nous" else {})
    api._aai_load_cfg = lambda: {"model": {"provider": "nous", "default": "x/m"}}
    api._aai_urlreq.urlopen = lambda req, timeout=0: (sent.append(req), _Resp({
        "id": "gen-1", "choices": [{"message": {"content": "hi"}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 1000, "completion_tokens": 100, "prompt_tokens_details": {"cached_tokens": 400}}}))[1]
    try:
        return fn(sent)
    finally:
        api._aai_load_cfg, api._aai_urlreq.urlopen = load, urlopen
        for k, v in saved.items():
            if v is None:
                sys.modules.pop(k, None)
            else:
                sys.modules[k] = v


def test_replays_on_a_nous_profile_go_to_nous_portal():
    def check(sent):
        rt = api._aai_runtime()
        assert rt == {"api_key": "nous-jwt", "base_url": "https://inference-api.nousresearch.com/v1", "kind": "nous"}
        out = api._aai_call("x/m", MSGS, provider={"data_collection": "deny"})
        req = sent[-1]
        body = json.loads(req.data)
        assert req.full_url == "https://inference-api.nousresearch.com/v1/chat/completions"
        assert req.get_header("Authorization") == "Bearer nous-jwt" and not req.get_header("X-title")
        assert "provider" not in body and "usage" not in body, "OpenRouter's own fields stay off Nous calls"
        assert body["tags"] == ["product=hermes-agent"]
        assert abs(out["cost"] - (600e-6 + 400e-7 + 100 * 4e-6)) < 1e-12, "priced at the Portal's list, cache reads at the cache price"
    _on_nous(check)


def test_comparing_providers_on_nous_says_why_not():
    def check(sent):
        try:
            api._aai_call("x/m", MSGS, provider={"only": ["deepinfra"]})
            raise AssertionError("expected an error")
        except RuntimeError as exc:
            assert "OpenRouter" in str(exc) and not sent
    _on_nous(check)


def test_a_refused_replay_says_what_the_provider_said():
    import io
    import urllib.error

    def check(sent):
        body = b'{"status":404,"message":"Model x/m requires available credits.","code":"insufficient_credits_for_paid_model"}'
        def refuse(req, timeout=0):
            raise urllib.error.HTTPError(req.full_url, 404, "Not Found", {}, io.BytesIO(body))
        api._aai_urlreq.urlopen = refuse
        try:
            api._aai_call("x/m", MSGS)
            raise AssertionError("expected an error")
        except RuntimeError as exc:
            assert str(exc) == "Model x/m requires available credits."
    _on_nous(check)

def test_nous_spend_cap_becomes_a_limit_window():
    info = lambda **a: types.SimpleNamespace(paid_service_access_info=types.SimpleNamespace(**a))
    w = api._nous_spend_cap(info(member_spend_cap_usd=20.0, member_spend_usd=19.5))
    assert w["label"] == "Spend cap" and w["used_percent"] == 97.5 and w["detail"] == "$19.50 of $20.00"
    assert api._nous_spend_cap(info(member_spend_cap_usd=None, member_spend_usd=3.0)) is None, "no cap set"
    assert api._nous_spend_cap(info(member_spend_cap_usd=0, member_spend_usd=0)) is None
    assert api._nous_spend_cap(info(member_spend_cap_usd=float("nan"), member_spend_usd=1.0)) is None
    assert api._nous_spend_cap(types.SimpleNamespace()) is None, "an account without paid access info"


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
