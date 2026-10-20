"""Hermetic's own model calls go through Hermes: ctx.llm for helpers, the secret scope for replay keys.

Run with the Python that runs Hermes: python tests/test_credentials.py
"""
import importlib.util
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
    rt = api._aai_runtime()
    assert rt["api_key"] == "sk-or-test" and rt["base_url"] == "https://openrouter.ai/api/v1"
    assert scope["depth"] == 0


def test_replay_without_key_says_so():
    scope["key"] = None
    try:
        api._aai_runtime()
        raise AssertionError("expected an error without a key")
    except RuntimeError as exc:
        assert "OPENROUTER_API_KEY" in str(exc)
    finally:
        scope["key"] = "sk-or-test"


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
