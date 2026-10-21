"""hermetic backend plugin (formerly openrouter-meter).

Two halves:
  * ``dashboard/plugin_api.py`` - a FastAPI router the dashboard mounts at
    ``/api/plugins/hermetic/`` (account usage, per-session cost rows, provider routing rows).
  * the ``post_api_request`` hook below - records which upstream provider OpenRouter routed each
    call to. Hermes only exposes that field at response time, so it is appended to
    ``$HERMES_HOME/hermetic/routing.jsonl`` (metadata only: no prompt or response text).
  * the ``llm_request`` middleware below - Hermes forwards only six ``provider_routing`` keys to
    OpenRouter (only/ignore/order/sort/require_parameters/data_collection). This adds the rest of
    OpenRouter's provider-routing object from the same config block (and its ``models.<id>``
    overrides): allow_fallbacks, zdr, enforce_distillable_text, quantizations, max_price,
    preferred_min_throughput, preferred_max_latency. OpenRouter requests only; invalid values are
    dropped, never sent.
"""

import json
import os
import re
import time
from pathlib import Path

_MAX_BYTES = 8 * 1024 * 1024   # compact the file past this size
_KEEP_DAYS = 90

# Self-check: the llm_request middleware notes every OpenRouter request id it sees; the recorder
# marks each recorded call with whether that happened ("mw": 1/0). If a Hermes update stops calling
# the middleware, the routing extras (zdr, fallback, ...) silently stop reaching OpenRouter - the
# popover warns when recent calls carry mw=0.
import collections
import threading

_MW_SEEN = collections.OrderedDict()
_MW_LOCK = threading.Lock()
_MW_MAX = 4000

# Billed snapshots: OpenRouter's "today" total, saved by the backend after OpenRouter calls (at most
# every 15 minutes per Hermes home), so drift history no longer depends on the desktop app being
# open or on its local storage.
_SNAP_EVERY_S = 15 * 60
_SNAP_KEEP_DAYS = 400
_last_snap = {}

# Empty-reply debugging: when OpenRouter returns no text and no tool call, the hook keeps exactly
# what came back (provider, tokens, finish reason, generation id) per session. If the turn then
# ends in Hermes's "No reply" message, transform_llm_output appends those facts so the failure
# names the provider. Nothing is added when no empty call was recorded.
_EMPTY = {}             # session_id -> [record, ...] for the current run of empty calls
_EMPTY_LOCK = threading.Lock()
_EMPTY_TTL_S = 15 * 60
_EXEC = collections.OrderedDict()   # api_request_id -> {"gen": id, "native": native finish reason}
_EXEC_MAX = 2000


# ---- data folder: $HERMES_HOME/hermetic/ ---------------------------------------------------------
# The plugin was called openrouter-meter; its folder is merged in once (rows appended, billed days
# kept at their max, other files moved when missing) and left as openrouter-meter.migrated-<time>.
# The old folder is claimed with an atomic rename first, so two processes starting together never
# merge the same rows twice.
_DATA = "hermetic"
_LEGACY_DATA = "openrouter-meter"


def _merge_legacy(home):
    import json as _json
    import shutil as _shutil
    old = home / _LEGACY_DATA
    if not old.is_dir():
        return
    claimed = home / (_LEGACY_DATA + ".migrating-" + str(os.getpid()))
    try:
        os.rename(old, claimed)
    except OSError:
        return  # another process got it
    new = home / _DATA
    new.mkdir(parents=True, exist_ok=True)
    for item in claimed.iterdir():
        target = new / item.name
        try:
            if item.name == "routing.jsonl":
                data = item.read_text(encoding="utf-8")
                if data:
                    with open(target, "a", encoding="utf-8") as fh:
                        fh.write(data if data.endswith("\n") else data + "\n")
            elif item.name == "billed.json" and target.exists():
                a = _json.loads(target.read_text(encoding="utf-8"))
                b = _json.loads(item.read_text(encoding="utf-8"))
                days = dict(a.get("days") or {})
                for d, v in (b.get("days") or {}).items():
                    try:
                        days[d] = max(float(days.get(d) or 0), float(v or 0))
                    except (TypeError, ValueError):
                        continue
                a["days"] = days
                target.write_text(_json.dumps(a), encoding="utf-8")
            elif not target.exists():
                _shutil.move(str(item), str(target))
        except Exception:
            continue
    try:
        os.rename(claimed, home / (_LEGACY_DATA + ".migrated-" + time.strftime("%Y%m%d-%H%M%S")))
    except OSError:
        pass


def data_dir(home=None):
    """$HERMES_HOME/hermetic (or that of ``home``), after merging the pre-rename folder in."""
    if home is None:
        from hermes_constants import get_hermes_home
        home = get_hermes_home()
    home = Path(home)
    if (home / _LEGACY_DATA).is_dir():
        try:
            _merge_legacy(home)
        except Exception:
            pass
    return home / _DATA


def _routing_path() -> Path:
    return data_dir() / "routing.jsonl"


def _compact(path: Path) -> None:
    """Drop rows older than ``_KEEP_DAYS``; never raises."""
    try:
        cutoff = time.time() - _KEEP_DAYS * 86400
        keep = []
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                try:
                    if float(json.loads(line).get("ts", 0)) >= cutoff:
                        keep.append(line)
                except Exception:
                    continue
        tmp = path.with_suffix(".tmp")
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.writelines(keep)
        os.replace(tmp, path)
    except Exception:
        pass


def _on_post_api_request(**kw) -> None:
    try:
        provider = str(kw.get("provider") or "").lower()
        base_url = str(kw.get("base_url") or "").lower()
        if provider != "openrouter" and "openrouter" not in base_url:
            return
        response = kw.get("response") or {}
        usage = kw.get("usage") or {}
        if not isinstance(response, dict):
            response = {}
        if not isinstance(usage, dict):
            usage = {}
        row = {
            "ts": float(kw.get("ended_at") or time.time()),
            "session": kw.get("session_id") or "",
            "platform": kw.get("platform") or "",
            "model": kw.get("response_model") or response.get("model") or kw.get("model") or "",
            "requested": kw.get("model") or "",
            "upstream": response.get("upstream_provider") or "",
            "input": int(usage.get("input_tokens") or 0),
            "output": int(usage.get("output_tokens") or 0),
            "cache": int(usage.get("cache_read_tokens") or 0),
            "reasoning": int(usage.get("reasoning_tokens") or 0),
            "finish": kw.get("finish_reason") or "",
            "secs": round(float(kw.get("api_duration") or 0.0), 2),
        }
        rid = kw.get("api_request_id")
        if rid:
            with _MW_LOCK:
                row["mw"] = 1 if _MW_SEEN.pop(rid, None) else 0
        _note_reply(kw, row, rid)
        path = _routing_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(row, separators=(",", ":")) + "\n")
        try:
            if path.stat().st_size > _MAX_BYTES:
                _compact(path)
        except OSError:
            pass
        _maybe_snapshot_billed()
    except Exception:
        # A metering hook must never affect the agent.
        pass


def _note_reply(kw, row, rid) -> None:
    """Track runs of empty replies per session; marks the routing row with "empty": 1."""
    try:
        session = kw.get("session_id") or ""
        if not session:
            return
        chars = kw.get("assistant_content_chars")
        tools = kw.get("assistant_tool_call_count")
        if chars is None or tools is None:
            return  # Hermes stopped reporting these: say nothing rather than guess
        with _MW_LOCK:
            ex = _EXEC.pop(rid, None) if rid else None
        if int(chars) > 0 or int(tools) > 0:
            with _EMPTY_LOCK:
                _EMPTY.pop(session, None)
            return
        msg = kw.get("assistant_message")
        reasoning = getattr(msg, "reasoning", None) or getattr(msg, "reasoning_content", None)
        row["empty"] = 1
        rec = {
            "ts": row["ts"],
            "upstream": row["upstream"] or "unknown provider",
            "output": row["output"],
            "reasoning": row["reasoning"],
            "thought": bool(reasoning and str(reasoning).strip()),
            "finish": row["finish"] or "none",
            "native": (ex or {}).get("native") or "",
            "secs": row["secs"],
            "gen": (ex or {}).get("gen") or "",
        }
        with _EMPTY_LOCK:
            runs = [r for r in _EMPTY.get(session, []) if rec["ts"] - r["ts"] < _EMPTY_TTL_S]
            runs.append(rec)
            _EMPTY[session] = runs[-8:]
            for sid in [k for k, v in _EMPTY.items() if not v or time.time() - v[-1]["ts"] > _EMPTY_TTL_S]:
                _EMPTY.pop(sid, None)
    except Exception:
        pass


def _on_llm_execution(**kw):
    """Pass-through; reads the generation id and OpenRouter's native finish reason off the result."""
    result = kw["next_call"](kw.get("request"))
    try:
        rid = kw.get("api_request_id")
        provider = str(kw.get("provider") or "").lower()
        base_url = str(kw.get("base_url") or "").lower()
        if rid and (provider == "openrouter" or "openrouter" in base_url):
            gen = getattr(result, "id", None)
            native = ""
            choices = getattr(result, "choices", None) or []
            if choices:
                native = getattr(choices[0], "native_finish_reason", None) or ""
            with _MW_LOCK:
                _EXEC[rid] = {"gen": gen if isinstance(gen, str) else "", "native": native if isinstance(native, str) else ""}
                while len(_EXEC) > _EXEC_MAX:
                    _EXEC.popitem(last=False)
    except Exception:
        pass
    return result


def _routing_summary() -> str:
    try:
        from hermes_cli.config import load_config_readonly
        pr = (load_config_readonly() or {}).get("provider_routing")
        if not isinstance(pr, dict):
            return "default routing"
        parts = []
        if pr.get("sort"):
            parts.append("sort " + str(pr["sort"]))
        if pr.get("only"):
            parts.append("only " + ", ".join(map(str, pr["only"])))
        if pr.get("ignore"):
            parts.append("blocked " + ", ".join(map(str, pr["ignore"])))
        if pr.get("quantizations"):
            parts.append("precision " + ", ".join(map(str, pr["quantizations"])))
        if pr.get("zdr") is True:
            parts.append("zero retention")
        if str(pr.get("data_collection") or "") == "deny":
            parts.append("no data collection")
        if pr.get("require_parameters") is True:
            parts.append("all parameters")
        if pr.get("allow_fallbacks") is False:
            parts.append("no fallback")
        return ", ".join(parts) or "default routing"
    except Exception:
        return ""


def _what(r) -> str:
    kind = "only reasoning, no text or tool call" if r["thought"] or r["reasoning"] else "no text, no reasoning, no tool call"
    bits = [kind, str(r["output"]) + " tokens out", "finish " + r["finish"] + (" (provider said " + r["native"] + ")" if r["native"] and r["native"] != r["finish"] else ""), str(r["secs"]) + " s"]
    if r["gen"]:
        bits.append(r["gen"])
    return ", ".join(bits)


def _on_transform_llm_output(**kw):
    """Append the recorded empty replies to Hermes's "No reply" message; otherwise leave text alone."""
    try:
        text = kw.get("response_text")
        session = kw.get("session_id") or ""
        if not isinstance(text, str) or not session or "No reply" not in text:
            return None
        with _EMPTY_LOCK:
            runs = [r for r in _EMPTY.pop(session, []) if time.time() - r["ts"] < _EMPTY_TTL_S]
        if not runs:
            return None
        provs = collections.Counter(r["upstream"] for r in runs)
        head = " and ".join(p + (" " + str(n) + " times" if n > 1 else " once") for p, n in provs.items())
        lines = ["", "", "Debug (hermetic): empty reply from " + head + ", in a row:"]
        for r in runs:
            lines.append("- " + r["upstream"] + ": " + _what(r))
        summary = _routing_summary()
        if summary:
            lines.append("Routing rules for this profile: " + summary)
        return text.rstrip() + "\n".join(lines)
    except Exception:
        return None


_PROVIDER_IN_ERROR = re.compile(r"'provider_name': '([^']+)'")


def _on_api_request_error(**kw) -> None:
    """Record failed OpenRouter calls per upstream provider (rate limits, provider errors) for AAI."""
    try:
        provider = str(kw.get("provider") or "").lower()
        base_url = str(kw.get("base_url") or "").lower()
        if provider != "openrouter" and "openrouter" not in base_url:
            return
        err = kw.get("error") if isinstance(kw.get("error"), dict) else {}
        msg = str(err.get("message") or "")
        m = _PROVIDER_IN_ERROR.search(msg)
        status = kw.get("status_code")
        row = {"ts": time.time(), "session": kw.get("session_id") or "", "model": kw.get("model") or "",
               "provider": m.group(1) if m else "unknown", "status": int(status) if isinstance(status, int) else None,
               "type": "rate_limit" if status == 429 else str(err.get("type") or kw.get("reason") or "error")[:60]}
        path = data_dir() / "errors.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(row, separators=(",", ":")) + "\n")
    except Exception:
        pass


def _billed_path() -> Path:
    from hermes_constants import get_hermes_home
    return data_dir() / "billed.json"


def _snapshot_billed(path: Path) -> None:
    """Fetch OpenRouter's account usage and store today's (UTC) total; never raises."""
    import re
    try:
        from agent.account_usage import fetch_account_usage, render_account_usage_lines
        text = "\n".join(render_account_usage_lines(fetch_account_usage("openrouter")) or [])
        m = re.search(r"\$([\d,.]+) today", text)
        if not m:
            return
        today = float(m.group(1).replace(",", ""))
        day = time.strftime("%Y-%m-%d", time.gmtime())
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            data = {}
        days = data.get("days") if isinstance(data.get("days"), dict) else {}
        # a day's total only grows; keep the larger value if two processes race
        days[day] = max(today, float(days.get(day) or 0))
        for k in sorted(days)[:-_SNAP_KEEP_DAYS]:
            del days[k]
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"days": days, "updated": time.time()}, separators=(",", ":")), encoding="utf-8")
        os.replace(tmp, path)
    except Exception:
        pass


def _maybe_snapshot_billed() -> None:
    """Throttled, off the request thread, in the current profile's context (its home + key)."""
    try:
        import contextvars
        path = _billed_path()
        key = str(path)
        now = time.time()
        if now - _last_snap.get(key, 0) < _SNAP_EVERY_S:
            return
        _last_snap[key] = now
        ctx = contextvars.copy_context()
        threading.Thread(target=ctx.run, args=(_snapshot_billed, path), name="hermetic-billed", daemon=True).start()
    except Exception:
        pass


# ---- extra OpenRouter provider-routing keys ------------------------------------------------

_QUANTS = {"int4", "int8", "fp4", "mxfp4", "nvfp4", "fp6", "fp8", "mxfp8", "fp16", "bf16", "fp32", "unknown"}
_PERCENTILES = ("p50", "p75", "p90", "p99")
EXTRA_KEYS = ("allow_fallbacks", "zdr", "enforce_distillable_text", "quantizations", "max_price",
              "preferred_min_throughput", "preferred_max_latency")


def _num(v):
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)) and v == v and v >= 0:
        return v
    if isinstance(v, str):
        try:
            f = float(v.strip())
            return f if f >= 0 else None
        except ValueError:
            return None
    return None


def _bool(v):
    if isinstance(v, bool):
        return v
    if isinstance(v, str) and v.strip().lower() in ("true", "yes", "on", "false", "no", "off"):
        return v.strip().lower() in ("true", "yes", "on")
    return None


def _perf(v):
    """A number (applies to p50) or a {p50,p75,p90,p99: number} map."""
    n = _num(v)
    if n is not None and n > 0:
        return n
    if isinstance(v, dict):
        out = {k: _num(v[k]) for k in _PERCENTILES if k in v}
        out = {k: x for k, x in out.items() if x is not None and x > 0}
        return out or None
    return None


def clean_extra(raw):
    """Validate the extra keys; anything malformed is dropped rather than sent."""
    out = {}
    if not isinstance(raw, dict):
        return out
    b = _bool(raw.get("allow_fallbacks"))
    if b is False:  # true is OpenRouter's default; only send the restriction
        out["allow_fallbacks"] = False
    for key in ("zdr", "enforce_distillable_text"):
        if _bool(raw.get(key)) is True:
            out[key] = True
    q = raw.get("quantizations")
    if isinstance(q, str):
        q = [q]
    if isinstance(q, list):
        q = [str(x).strip().lower() for x in q if str(x).strip().lower() in _QUANTS]
        if q:
            out["quantizations"] = list(dict.fromkeys(q))
    mp = raw.get("max_price")
    if isinstance(mp, dict):
        mp = {k: _num(mp[k]) for k in ("prompt", "completion", "request", "image", "audio") if k in mp}
        mp = {k: v for k, v in mp.items() if v is not None}
        if mp:
            out["max_price"] = mp
    for key in ("preferred_min_throughput", "preferred_max_latency"):
        v = _perf(raw.get(key))
        if v is not None:
            out[key] = v
    return out


def _extra_for_model(model):
    from hermes_cli.config import load_config_readonly
    pr = (load_config_readonly() or {}).get("provider_routing")
    if not isinstance(pr, dict):
        return {}
    merged = {k: pr[k] for k in EXTRA_KEYS if k in pr}
    try:
        from hermes_constants import resolve_per_model_provider_routing
        per = resolve_per_model_provider_routing(model or "", pr.get("models")) or {}
    except Exception:
        per = {}
    merged.update({k: per[k] for k in EXTRA_KEYS if k in per})
    return clean_extra(merged)


def merge_into_request(request, extra):
    """Return a copy of ``request`` with ``extra`` set on ``extra_body.provider``, or None if unchanged."""
    if not extra or not isinstance(request, dict):
        return None
    body = request.get("extra_body")
    body = dict(body) if isinstance(body, dict) else {}
    prov = body.get("provider")
    prov = dict(prov) if isinstance(prov, dict) else {}
    changed = False
    for k, v in extra.items():
        if prov.get(k) != v:
            prov[k] = v
            changed = True
    if not changed:
        return None
    body["provider"] = prov
    new = dict(request)
    new["extra_body"] = body
    return new


def _on_llm_request(**kw):
    try:
        provider = str(kw.get("provider") or "").lower()
        base_url = str(kw.get("base_url") or "").lower()
        if provider != "openrouter" and "openrouter" not in base_url:
            return None
        rid = kw.get("api_request_id")
        if rid:
            with _MW_LOCK:
                _MW_SEEN[rid] = 1
                while len(_MW_SEEN) > _MW_MAX:
                    _MW_SEEN.popitem(last=False)
        request = kw.get("request")
        model = kw.get("model") or (request.get("model") if isinstance(request, dict) else "")
        extra = _extra_for_model(model)
        new = merge_into_request(request, extra)
        if new is None:
            return None
        return {"request": new, "source": "hermetic", "reason": "provider_routing: " + ", ".join(sorted(extra))}
    except Exception:
        # Routing extras must never break a request: on any error the request goes out unchanged.
        return None


# ---- HDR guard: ask (through Hermes' approval prompt) or block before a risky tool call ----------
# One level per profile in hermetic/hdr/guard.json: watch (default, records only), ask or block. It acts
# only on what Hermes does not check itself (hdr_rules.guarded: reading keys and logins, writing startup
# items and key places Hermes does not list). Its own errors never block.
_GUARD_LEVELS = ("watch", "ask", "block")
_GUARD_CACHE = {}
_RULES = {}
_OP_WORDS = {"read": "read", "write": "write", "code": "use in code", "workdir": "work in"}


def _hdr_rules():
    mod = _RULES.get("m")
    if mod is None:
        import importlib.util
        spec = importlib.util.spec_from_file_location("_hermetic_hdr_rules", str(Path(__file__).resolve().with_name("hdr_rules.py")))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _RULES["m"] = mod
    return mod


def guard_level(home=None) -> str:
    """This profile's guard level, re-read only when guard.json changes."""
    p = data_dir(home) / "hdr" / "guard.json"
    try:
        mtime = p.stat().st_mtime
    except OSError:
        return "watch"
    hit = _GUARD_CACHE.get(str(p))
    if hit and hit[0] == mtime:
        return hit[1]
    try:
        level = json.loads(p.read_text(encoding="utf-8")).get("level")
    except Exception:
        level = None
    level = level if level in _GUARD_LEVELS else "watch"
    _GUARD_CACHE[str(p)] = (mtime, level)
    return level


def _guard_log(row: dict) -> None:
    try:
        p = data_dir() / "hdr" / "guard.jsonl"
        p.parent.mkdir(parents=True, exist_ok=True)
        with open(p, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(row, separators=(",", ":")) + "\n")
    except Exception:
        pass


def _on_pre_tool_call(tool_name="", args=None, task_id="", **kw):
    try:
        if tool_name == "tool_call":  # Hermes unwraps batches; each call inside comes through on its own
            return None
        level = guard_level()
        if level == "watch":
            return None
        rules = _hdr_rules()
        hits = [h for h in rules.risky(tool_name, args) if rules.guarded(h)]
        if not hits:
            return None
        top = hits[0]
        what = "%s %s (%s)" % (_OP_WORDS.get(top["op"], top["op"]), top["path"], top["why"])
        _guard_log({"ts": time.time(), "action": level, "tool": tool_name, "path": top["path"], "op": top["op"],
                    "why": top["why"], "score": top["score"], "session_id": kw.get("session_id") or task_id or ""})
        if level == "block":
            return {"action": "block", "message": "Blocked by Hermetic's HDR guard: this would " + what
                    + ". If it is needed, ask the user; they can change the guard in Hermetic, HDR."}
        return {"action": "approve", "message": "Hermetic's HDR guard: this %s call would %s." % (tool_name, what),
                "rule_key": "hermetic:%s:%s" % (top["op"], top["path"])}
    except Exception:
        return None


def register(ctx) -> None:
    try:
        ctx.register_hook("post_api_request", _on_post_api_request)
    except Exception:
        pass
    try:
        ctx.register_middleware("llm_request", _on_llm_request)
    except Exception:
        pass
    try:
        ctx.register_middleware("llm_execution", _on_llm_execution)
    except Exception:
        pass
    try:
        ctx.register_hook("transform_llm_output", _on_transform_llm_output)
    except Exception:
        pass
    try:
        ctx.register_hook("api_request_error", _on_api_request_error)
    except Exception:
        pass
    try:
        ctx.register_hook("pre_tool_call", _on_pre_tool_call)
    except Exception:
        pass
