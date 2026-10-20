/**
 * Hermetic: a status-bar popover for the Hermes desktop app with two views.
 *
 *   Costs  spend per day and session, cache hit rate, OpenRouter provider routing
 *          (which providers served you, where they are, your routing rules) and
 *          one-click config fixes.
 *   AAI    applied-AI quality: what your skills did, replies you rate, corrections
 *          kept as tests, replays on other versions, providers or models, and
 *          automatic tests when the background review changes a skill.
 *
 * Data comes from surfaces the desktop app already has (/api/analytics/usage,
 * /api/profiles/sessions, /api/config/raw, /api/logs, session.usage ticks, the public
 * OpenRouter /models list) plus this plugin's own backend under /api/plugins/hermetic/.
 * No API key ever reaches the renderer. OpenRouter-only parts hide when the profile
 * does not use OpenRouter.
 *
 * Plain ESM, loaded uncompiled: jsx() calls, never JSX syntax.
 */

import { cn, host, Popover, PopoverContent, PopoverTrigger, SegmentedControl, Tip, useValue } from '@hermes/plugin-sdk'
import { useEffect, useMemo, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'hermetic'
const LEGACY_ID = 'openrouter-meter'
const REFRESH_MS = 60_000
const PRICES_TTL_MS = 24 * 3600_000
const LIVE_WINDOW_MS = 10 * 60_000
const DEFAULT_DAYS = 30

// ---- element helper ---------------------------------------------------------

const el = (type, props, ...kids) => {
  const p = props || {}
  if (kids.length === 0) return jsx(type, p)
  if (kids.length === 1 && !Array.isArray(kids[0])) return jsx(type, { ...p, children: kids[0] })
  return jsxs(type, { ...p, children: kids.length === 1 ? kids[0] : kids })
}

// ---- storage (captured at register) ----------------------------------------

let store = null
const sget = (k, fb) => {
  try {
    const v = store && store.get(k, fb)
    return v === undefined ? fb : v
  } catch {
    return fb
  }
}
const sset = (k, v) => {
  try {
    store && store.set(k, v)
  } catch {
    /* storage unavailable */
  }
}

// ---- formatting -------------------------------------------------------------

const num = v => (typeof v === 'number' && isFinite(v) ? v : 0)
const fmtUsd = (c, opts) => {
  const v = num(c)
  const sign = opts && opts.approx ? '~' : ''
  if (v === 0) return sign + '$0'
  if (v < 0.01) return sign + '<$0.01'
  if (v < 1000) return sign + '$' + v.toFixed(2)
  return sign + '$' + Math.round(v).toLocaleString()
}
const fmtRate = c => {
  const v = num(c)
  if (v < 0.005) return '$0/h'
  return (v < 10 ? '$' + v.toFixed(2) : '$' + v.toFixed(1)) + '/h'
}
const fmtTok = n => {
  const v = num(n)
  if (v >= 1e6) return (v / 1e6).toFixed(v < 1e7 ? 1 : 0) + 'M'
  if (v >= 1e3) return Math.round(v / 1e3) + 'K'
  return String(Math.round(v))
}
const fmtPct = p => Math.round(num(p)) + '%'
// prompt tokens served from the provider's cache, as a fraction (input excludes cache reads)
const hitRate = (input, cache) => (num(input) + num(cache) > 0 ? num(cache) / (num(input) + num(cache)) : null)
const fmtHit = h => (h == null ? '-' : h >= 0.9995 ? '100%' : (h * 100).toFixed(1).replace(/\.0$/, '') + '%')
// share of a total as an exact percentage: 2.4%, 0.6%, 0.04%
const fmtShare = f => {
  const p = num(f) * 100
  if (p <= 0) return '0%'
  if (p >= 10) return Math.round(p) + '%'
  if (p >= 0.1) return p.toFixed(1).replace(/\.0$/, '') + '%'
  return p.toPrecision(1) + '%'
}
const dateStr = d =>
  d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
const dayLabel = s => {
  const d = new Date(s + 'T12:00:00')
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
const weekday = s => new Date(s + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short' })
const shortModel = m => String(m || '').replace(/^[^/]+\//, '')
const trunc = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '')

// OpenRouter's key usage windows are UTC calendar periods: usage_weekly is the current UTC week
// starting Monday, usage_monthly the current UTC month. Return the local day key that window starts on.
const accountWindowStart = period => {
  const now = new Date()
  let startUtc
  if (period === '7d') {
    const back = (now.getUTCDay() + 6) % 7
    startUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - back)
  } else {
    startUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  }
  return dateStr(new Date(startUtc))
}

const lastNDays = n => {
  const out = []
  const d = new Date()
  d.setHours(12, 0, 0, 0)
  for (let i = n - 1; i >= 0; i--) {
    const x = new Date(d)
    x.setDate(d.getDate() - i)
    out.push(dateStr(x))
  }
  return out
}
const dayStart = s => new Date(s + 'T00:00:00').getTime() / 1000
const median = arr => {
  const a = arr.filter(v => v > 0).sort((x, y) => x - y)
  if (!a.length) return 0
  const m = Math.floor(a.length / 2)
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2
}

// Saved state (period, billed days, cache resets, caches) lived under the old plugin id; copy each
// key across once, never overwriting, and leave the old keys in place.
function carryOverLegacyStorage() {
  try {
    const from = 'hermes.plugin.' + LEGACY_ID + '.'
    const to = 'hermes.plugin.' + ID + '.'
    const keys = []
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i)
      if (k && k.startsWith(from)) keys.push(k)
    }
    for (const k of keys) {
      const dst = to + k.slice(from.length)
      if (window.localStorage.getItem(dst) == null) window.localStorage.setItem(dst, window.localStorage.getItem(k))
    }
  } catch {
    /* storage unavailable: start fresh */
  }
}

// ---- data: HTTP via the desktop bridge --------------------------------------

const api = req => window.hermesDesktop.api(req)

// The name the Bots sidebar shows for a profile: its bot title, then display name, then the
// profile name tidied ("my-profile" -> "My Profile"); the default profile reads "Hermes".
const botLabel = p => {
  const t = String(p.bot_title || '').trim() || String(p.display_name || '').trim()
  if (t) return t
  if (p.is_default || p.name === 'default') return 'Hermes'
  return String(p.name || '').replace(/[-_]+/g, ' ').trim().replace(/\b\w/g, c => c.toUpperCase())
}

async function loadProfiles() {
  try {
    const r = await api({ path: '/api/profiles' })
    const list = (r && r.profiles) || []
    return list.map(p => ({ name: p.name, isDefault: !!p.is_default, label: botLabel(p) }))
  } catch {
    return [{ name: 'default', isDefault: true }]
  }
}

async function loadAnalytics(profiles, days, prices) {
  const daily = new Map() // day -> merged record
  const aux = new Map() // model -> { task -> {input, output, cost} }
  const byModel = new Map() // model -> {input, output, cost, calls}
  let total = 0
  const estimated = new Map() // model Hermes had no price for -> OpenRouter id it was priced at
  let unpriced = false
  await Promise.all(
    profiles.map(async p => {
      try {
        const q = '/api/analytics/usage?days=' + days + (p.isDefault ? '' : '&profile=' + encodeURIComponent(p.name))
        const r = await api({ path: q })
        // a profile Hermes priced at $0 despite tokens (custom endpoints): blend list prices of its models
        const priced = ((r && r.daily) || []).reduce((a, d) => a + num(d.estimated_cost), 0) > 0
        let blend = null
        if (!priced) {
          const w = { in: 0, out: 0, cache: 0, tin: 0, tout: 0, tcache: 0 }
          for (const m of (r && r.by_model) || []) {
            const id = priceIdOf(prices, m.model)
            const pr = id ? prices[id] : null
            const tin = num(m.input_tokens), tout = num(m.output_tokens), tc = num(m.cache_read_tokens)
            if (!pr) { if (tin + tout + tc > 0) unpriced = true; continue }
            if (tin + tout + tc > 0) estimated.set(m.model, id)
            w.in += tin * pr.in; w.tin += tin
            w.out += tout * pr.out; w.tout += tout
            w.cache += tc * (pr.cache != null ? pr.cache : pr.in); w.tcache += tc
          }
          if (w.tin + w.tout + w.tcache > 0) blend = { in: w.tin ? w.in / w.tin : 0, out: w.tout ? w.out / w.tout : 0, cache: w.tcache ? w.cache / w.tcache : 0 }
        }
        for (const d of (r && r.daily) || []) {
          const cur = daily.get(d.day) || { day: d.day, cost: 0, input: 0, output: 0, cache: 0, calls: 0, sessions: 0 }
          const dayCost = num(d.estimated_cost) || (blend ? costAt(blend, d.input_tokens, d.output_tokens, d.cache_read_tokens) : 0)
          cur.cost += dayCost
          cur.input += num(d.input_tokens)
          cur.output += num(d.output_tokens)
          cur.cache += num(d.cache_read_tokens)
          cur.calls += num(d.api_calls)
          cur.sessions += num(d.sessions)
          daily.set(d.day, cur)
          total += dayCost
        }
        for (const m of (r && r.by_model) || []) {
          const cur = byModel.get(m.model) || { input: 0, output: 0, cost: 0, calls: 0 }
          cur.input += num(m.input_tokens)
          cur.output += num(m.output_tokens)
          cur.cost += num(m.estimated_cost) || (!priced ? costAt(priceOf(prices, m.model), m.input_tokens, m.output_tokens, m.cache_read_tokens) || 0 : 0)
          cur.calls += num(m.api_calls)
          byModel.set(m.model, cur)
          for (const t of m.aux_tasks || []) {
            const tasks = aux.get(m.model) || new Map()
            const c = tasks.get(t.task) || { input: 0, output: 0, cost: 0, calls: 0 }
            c.input += num(t.input_tokens)
            c.output += num(t.output_tokens)
            c.cost += num(t.estimated_cost)
            c.calls += num(t.api_calls)
            tasks.set(t.task, c)
            aux.set(m.model, tasks)
          }
        }
      } catch {
        /* one profile down must not blank the others */
      }
    })
  )
  return { daily, aux, byModel, total, estimated, unpriced }
}

async function loadAllAnalytics(profiles, prices) {
  const [d1, d7, d30] = await Promise.all([loadAnalytics(profiles, 1, prices), loadAnalytics(profiles, 7, prices), loadAnalytics(profiles, DEFAULT_DAYS, prices)])
  return { daily: d30.daily, periods: { today: d1, '7d': d7, '30d': d30 } }
}

const mapSessionRow = (s, profile) => ({
  id: s.id,
  title: s.title || s.display_name || s.preview || 'untitled',
  source: s.source || '',
  model: s.model || '',
  profile: profile || s.profile || '',
  parent: s.parent_session_id || null,
  calls: num(s.api_call_count),
  input: num(s.input_tokens),
  output: num(s.output_tokens),
  cache: num(s.cache_read_tokens),
  reasoning: num(s.reasoning_tokens),
  cost: num(s.actual_cost_usd) || num(s.estimated_cost_usd),
  started: num(s.started_at),
  last: num(s.last_active) || num(s.last_activity_at) || num(s.started_at),
  active: !!s.is_active,
  provider: s.billing_provider || '',
  base: s.billing_base_url || ''
})

async function loadSessions(profiles) {
  const out = []
  let complete = true
  await Promise.all(
    (profiles || [{ name: 'default', isDefault: true }]).map(async p => {
      try {
        const suffix = '?days=' + DEFAULT_DAYS + (p.isDefault ? '' : '&profile=' + encodeURIComponent(p.name))
        let r = null
        for (const base of ['/api/plugins/hermetic/sessions', '/api/analytics/sessions']) {
          try {
            const got = await api({ path: base + suffix })
            if (got && Array.isArray(got.sessions)) {
              r = got
              break
            }
          } catch {
            /* try the next source */
          }
        }
        if (!r) throw new Error('no route')
        for (const row of r.sessions) out.push(mapSessionRow(row, p.name))
      } catch {
        complete = false
      }
    })
  )
  if (out.length) return { sessions: out, complete }
  try {
    const r = await api({ path: '/api/profiles/sessions?limit=400&archived=include&order=recent' })
    return { sessions: ((r && r.sessions) || []).map(row => mapSessionRow(row)), complete: false }
  } catch {
    return { sessions: [], complete: false }
  }
}

async function loadPrices() {
  const cached = sget('prices', null)
  if (cached && Date.now() - cached.t < PRICES_TTL_MS && cached.map) return cached.map
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models')
    if (!res.ok) throw new Error(String(res.status))
    const body = await res.json()
    const map = {}
    for (const m of (body && body.data) || []) {
      const p = m && m.pricing
      if (!m || !p) continue
      const r = {
        in: parseFloat(p.prompt) * 1e6,
        out: parseFloat(p.completion) * 1e6,
        cache: p.input_cache_read != null ? parseFloat(p.input_cache_read) * 1e6 : null,
        ctx: num(m.context_length) || null
      }
      if (isFinite(r.in) && isFinite(r.out)) map[m.id] = r
    }
    sset('prices', { t: Date.now(), map })
    return map
  } catch {
    return (cached && cached.map) || {}
  }
}

async function loadCheapestEndpoint(model) {
  if (!model) return null
  const key = 'endpoint:' + model
  const cached = sget(key, null)
  if (cached && Date.now() - cached.t < PRICES_TTL_MS) return cached.v
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models/' + model + '/endpoints')
    if (!res.ok) throw new Error(String(res.status))
    const body = await res.json()
    const eps = ((body && body.data && body.data.endpoints) || [])
      .filter(e => e && e.pricing && e.tag && e.status !== -1 && (e.supports_implicit_caching !== false))
      .map(e => ({
        tag: e.tag,
        name: e.provider_name || e.tag,
        in: parseFloat(e.pricing.prompt) * 1e6,
        out: parseFloat(e.pricing.completion) * 1e6,
        cache: e.pricing.input_cache_read != null ? parseFloat(e.pricing.input_cache_read) * 1e6 : null
      }))
      .filter(e => isFinite(e.in) && isFinite(e.out))
    // Weighted by this user's mix: context re-reads dominate, so the cache price matters most.
    eps.sort((a, b) => (a.cache != null ? a.cache : a.in) * 20 + a.in + a.out * 0.1 - ((b.cache != null ? b.cache : b.in) * 20 + b.in + b.out * 0.1))
    const v = eps[0] || null
    sset(key, { t: Date.now(), v })
    return v
  } catch {
    return (cached && cached.v) || null
  }
}

// The profile whose chat is open; config edits and background-task routing follow it. Cost data
// keeps aggregating every profile. 'default' needs no routing hint.
const profileReq = (profile, req) => (profile && profile !== 'default' ? { ...req, profile } : req)

async function loadConfigRaw(profile) {
  try {
    const r = await api(profileReq(profile, { path: '/api/config/raw' }))
    return (r && r.yaml) || ''
  } catch {
    return ''
  }
}

// Does this profile's main model go through OpenRouter? true/false from model.provider or
// model.base_url; null for "auto" (then recorded OpenRouter calls decide).
// One key of the model block, whatever the indentation (2 spaces, 4, a tab) or an inline {...} form.
function modelKey(yaml, key) {
  const block = yamlBlock(yaml, 'model')
  const first = block.find(x => /^\s+\S/.test(x))
  const depth = first ? first.match(/^\s+/)[0] : '  '
  const l = block.find(x => x.startsWith(depth + key + ':'))
  if (l) return l.split(':').slice(1).join(':').replace(/#.*$/, '').replace(/['"]/g, '').trim()
  const inline = String(yaml).split('\n').find(x => /^model:\s*\{/.test(x)) || ''
  const m = new RegExp('[{,\\s]' + key + ':\\s*["\']?([^,}"\']+)').exec(inline)
  return m ? m[1].trim() : ''
}

function configUsesOpenRouter(yaml) {
  const provider = modelKey(yaml, 'provider').toLowerCase()
  if (provider === 'openrouter' || /openrouter\.ai/i.test(modelKey(yaml, 'base_url'))) return true
  if (!provider || provider === 'auto') return null
  return false
}

function parseThreshold(yaml) {
  const lines = String(yaml).split('\n')
  const i = lines.findIndex(l => /^compression:\s*$/.test(l))
  if (i < 0) return 0.5
  for (let j = i + 1; j < lines.length; j++) {
    if (/^[A-Za-z_]/.test(lines[j])) break
    const m = lines[j].match(/^\s+threshold:\s*([0-9.]+)/)
    if (m) return parseFloat(m[1])
  }
  return 0.5
}

// The provider a profile's model calls go to, as a short name for labels ("OpenRouter", "hopscotchlabs.ai").
function providerLabel(yaml) {
  if (configUsesOpenRouter(yaml) === true) return 'OpenRouter'
  const prov = modelKey(yaml, 'provider').toLowerCase()
  const known = { nous: 'Nous Portal', anthropic: 'Anthropic', openai: 'OpenAI', gemini: 'Google', google: 'Google' }[prov]
  if (known) return known
  const host = (/\/\/([^/:]+)/.exec(modelKey(yaml, 'base_url')) || [])[1]
  if (host) return host.replace(/^(api|inference-api|inference)\./, '')
  return prov && prov !== 'auto' && prov !== 'custom' ? prov : 'Hermes'
}

const sessionProvider = s => {
  const p = String(s.provider || ''), b = String(s.base || '')
  if (/openrouter/i.test(p + b)) return 'OpenRouter'
  const host = (/\/\/([^/:]+)/.exec(b) || [])[1]
  return host ? host.replace(/^(api|inference-api|inference)\./, '') : p.replace(/^custom:/, '').replace(/^(api|inference-api|inference)\./, '')
}

function yamlBlock(yaml, top) {
  const lines = String(yaml).split('\n')
  const i = lines.findIndex(l => new RegExp('^' + top + ':\\s*$').test(l))
  if (i < 0) return []
  const out = []
  for (let j = i + 1; j < lines.length; j++) {
    if (/^[A-Za-z_]/.test(lines[j])) break
    out.push(lines[j])
  }
  return out
}

function configFacts(yaml) {
  const pr = yamlBlock(yaml, 'provider_routing')
  const aux = yamlBlock(yaml, 'auxiliary')
  const scalar = key => {
    const l = pr.find(x => new RegExp('^\\s{2}' + key + ':').test(x))
    return l ? l.split(':').slice(1).join(':').replace(/#.*$/, '').replace(/['"]/g, '').trim() : null
  }
  const list = key => {
    const i = pr.findIndex(x => new RegExp('^\\s{2}' + key + ':').test(x))
    const out = []
    if (i < 0) return out
    const inline = pr[i].match(/:\s*\[(.*)\]\s*$/)
    if (inline) return inline[1].split(',').map(x => x.replace(/['"]/g, '').trim()).filter(Boolean)
    for (let k = i + 1; k < pr.length && /^\s{4}-/.test(pr[k]); k++) out.push(pr[k].replace(/^\s{4}-\s*/, '').replace(/['"]/g, '').trim())
    return out
  }
  // a nested map, block form (key:\n    a: 1) or inline form (key: {a: 1, b: 2})
  const submap = key => {
    const i = pr.findIndex(x => new RegExp('^\\s{2}' + key + ':').test(x))
    const out = {}
    if (i < 0) return out
    const inline = pr[i].match(/:\s*\{(.*)\}\s*$/)
    const pairs = inline ? inline[1].split(',') : []
    if (!inline) for (let k = i + 1; k < pr.length && /^\s{4}\S/.test(pr[k]); k++) pairs.push(pr[k])
    for (const pair of pairs) {
      const m = pair.replace(/#.*$/, '').match(/^\s*['"]?([A-Za-z0-9_]+)['"]?\s*:\s*(.+?)\s*$/)
      if (m) out[m[1]] = m[2].replace(/['"]/g, '')
    }
    return out
  }
  const bool = key => {
    const v = scalar(key)
    return v == null ? null : /^(true|yes|on)$/i.test(v)
  }
  // preferred_* is a number (p50) or a percentile map; the editor edits p50 and keeps the rest
  const perf = key => {
    const v = scalar(key)
    if (v && /^[0-9.]+$/.test(v)) return { p50: v, rest: {} }
    const m = submap(key)
    const { p50, ...rest } = m
    return { p50: p50 || '', rest }
  }
  const mp = submap('max_price')
  const { prompt: maxIn, completion: maxOut, ...maxRest } = mp
  const tps = perf('preferred_min_throughput')
  const lat = perf('preferred_max_latency')
  const modelsAt = pr.findIndex(x => /^\s{2}models:/.test(x))
  let models = 0
  if (modelsAt >= 0) for (let k = modelsAt + 1; k < pr.length && /^\s{4}/.test(pr[k]); k++) if (/^\s{4}\S/.test(pr[k])) models++
  const auxLine = aux.find(l => /^\s{2}openrouter_model:/.test(l))
  const rp = scalar('require_parameters')
  return {
    sort: scalar('sort') || null,
    only: list('only'),
    ignore: list('ignore'),
    order: list('order'),
    requireParams: rp != null && /^(true|yes|on)$/i.test(rp),
    dataCollection: scalar('data_collection') || null,
    allowFallbacks: bool('allow_fallbacks') !== false,
    zdr: bool('zdr') === true,
    distill: bool('enforce_distillable_text') === true,
    quants: list('quantizations').map(x => x.toLowerCase()),
    maxIn: maxIn || '',
    maxOut: maxOut || '',
    maxRest,
    minTps: tps.p50,
    tpsRest: tps.rest,
    maxLat: lat.p50,
    latRest: lat.rest,
    models,
    auxModel: auxLine ? auxLine.split(':').slice(1).join(':').replace(/['"]/g, '').trim() : null
  }
}

async function loadRetries(sinceDay) {
  const since = sinceDay || '0000-00-00'
  const count = async search => {
    try {
      const r = await host.logs({ file: 'agent', lines: 2000, level: 'WARNING', search })
      return ((r && r.lines) || []).filter(l => l.slice(0, 10) >= since).length
    } catch {
      return 0
    }
  }
  const [a, b] = await Promise.all([count('Retrying API call'), count('Stream drop')])
  return a + b
}

// ---- OpenRouter account (server-side fetch, parsed from session.usage) -------

const money = (re, text) => {
  const m = text.match(re)
  return m ? parseFloat(m[1].replace(/,/g, '')) : null
}

// ---- provider routing: which upstream provider OpenRouter sent each call to ----
// Recorded by the backend plugin's post_api_request hook; served at /api/plugins/hermetic/routing.

// Provider company domicile. OpenRouter does not publish this; keyed by lower-case alphanumerics of
// the provider display name. DEC = decentralised networks whose nodes can be anywhere.
const PROVIDER_REGION = {
  zai: 'CN', zhipu: 'CN', zhipuai: 'CN', novita: 'CN', novitaai: 'CN', siliconflow: 'CN', alibaba: 'CN', alibabacloud: 'CN', baidu: 'CN',
  deepseek: 'CN', streamlake: 'CN', moonshot: 'CN', moonshotai: 'CN', minimax: 'CN', tencent: 'CN', bytedance: 'CN', volcengine: 'CN',
  deepinfra: 'US', together: 'US', togetherai: 'US', fireworks: 'US', fireworksai: 'US', baseten: 'US', parasail: 'US', inferencenet: 'US',
  morph: 'US', relace: 'US', wafer: 'US', cloudflare: 'US', crusoe: 'US', modal: 'US', venice: 'US', coreweave: 'US', digitalocean: 'US',
  groq: 'US', cerebras: 'US', openai: 'US', anthropic: 'US', google: 'US', googlevertex: 'US', googleaistudio: 'US', amazonbedrock: 'US',
  azure: 'US', lambda: 'US', hyperbolic: 'US', sambanova: 'US', xai: 'US', perplexity: 'US', gmicloud: 'US', atlascloud: 'US', reka: 'US',
  ionstream: 'US', nvidia: 'US', meta: 'US', cohere: 'US', ai21: 'US', avian: 'US', featherless: 'US', nineteen: 'DEC', targon: 'DEC',
  mistral: 'EU', nebius: 'EU', scaleway: 'EU', ovh: 'EU', ovhcloud: 'EU', ionos: 'EU', alephalpha: 'EU',
  friendli: 'KR', decart: 'IL', dekallm: 'ID',
  phala: 'DEC', akashml: 'DEC', akash: 'DEC', chutes: 'DEC', ionet: 'DEC', primeintellect: 'DEC', enfer: 'DEC'
}
// Policy-line icons: 16x16 strokes in currentColor.
const POLICY_ICONS = {
  price: ['M8 2v12', 'M11 5H6.5a2 2 0 0 0 0 4h3a2 2 0 0 1 0 4H5'],
  eyeoff: ['M2 8s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4Z', 'M9.8 8a1.8 1.8 0 1 1-3.6 0 1.8 1.8 0 0 1 3.6 0Z', 'M3 13 13 3'],
  shield: ['M8 1.8 13 3.8v4c0 3-2.2 5.2-5 6.4C5.2 13 3 10.8 3 7.8v-4Z', 'm5.8 8 1.6 1.6L10.4 6.6'],
  // storage with a line through it: nothing kept (zero retention)
  dboff: ['M3 3.8a5 1.8 0 1 0 10 0a5 1.8 0 1 0 -10 0Z', 'M3 3.8v8.4c0 1 2.2 1.8 5 1.8s5-.8 5-1.8V3.8', 'M3 8c0 1 2.2 1.8 5 1.8s5-.8 5-1.8', 'M1.8 1.8l12.4 12.4'],
  nofall: ['M6.5 9.5 4.8 11.2a2.3 2.3 0 0 1-3.2-3.2L3.3 6.3', 'M9.5 6.5l1.7-1.7a2.3 2.3 0 0 1 3.2 3.2l-1.7 1.7', 'M3 3l10 10'],
  layers: ['m8 2 6 3.2L8 8.4 2 5.2Z', 'm2 8 6 3.2L14 8', 'M2 10.8 8 14l6-3.2'],
  ban: ['M13.6 8a5.6 5.6 0 1 1-11.2 0 5.6 5.6 0 0 1 11.2 0Z', 'M4 12 12 4'],
  only: ['M2.5 3.5h11l-4.3 5v4.5l-2.4-1.3V8.5Z'],
  order: ['M6 4h8', 'M6 8h8', 'M6 12h8', 'M2.6 3.2h.9v2.6'],
  params: ['M5 2.5h6a2.5 2.5 0 0 1 2.5 2.5v6a2.5 2.5 0 0 1-2.5 2.5H5A2.5 2.5 0 0 1 2.5 11V5A2.5 2.5 0 0 1 5 2.5Z', 'm5.4 8.2 1.8 1.8 3.6-3.8'],
  chip: ['M5.5 4h5A1.5 1.5 0 0 1 12 5.5v5a1.5 1.5 0 0 1-1.5 1.5h-5A1.5 1.5 0 0 1 4 10.5v-5A1.5 1.5 0 0 1 5.5 4Z', 'M6.5 2v2M9.5 2v2M6.5 12v2M9.5 12v2M2 6.5h2M2 9.5h2M12 6.5h2M12 9.5h2'],
  cap: ['M3 4h10', 'M8 6.5v7', 'M10.2 8.2H7.1a1.2 1.2 0 0 0 0 2.4h1.8a1.2 1.2 0 0 1 0 2.4H5.8'],
  speed: ['M2.5 11.5a5.5 5.5 0 1 1 11 0', 'M8 11.5 10.8 7'],
  book: ['M3 3.5A1.5 1.5 0 0 1 4.5 2H13v10H4.5A1.5 1.5 0 0 0 3 13.5Z', 'M3 13.5A1.5 1.5 0 0 0 4.5 15H13v-3'],
  sliders: ['M2 4.5h12', 'M2 11.5h12', 'M6 4.5a1.6 1.6 0 1 1-3.2 0 1.6 1.6 0 0 1 3.2 0Z', 'M13.2 11.5a1.6 1.6 0 1 1-3.2 0 1.6 1.6 0 0 1 3.2 0Z']
}

const REGION_LABEL_BASE = { US: 'US', EU: 'EU', CN: 'China', DEC: 'decentralised', KR: 'Korea', IL: 'Israel', ID: 'Indonesia', GB: 'UK', '?': 'unknown' }
// any other two-letter country code reads as its English name (SG → Singapore)
const countryName = (() => {
  try {
    const dn = new Intl.DisplayNames(['en'], { type: 'region' })
    return code => {
      try {
        return dn.of(code)
      } catch {
        return code
      }
    }
  } catch {
    return code => code
  }
})()
const REGION_LABEL = new Proxy(REGION_LABEL_BASE, {
  get: (t, k) => (k in t ? t[k] : typeof k === 'string' && /^[A-Z]{2}$/.test(k) ? countryName(k) : undefined)
})
const REGION_COLOR = { US: 'var(--ui-green)', EU: 'var(--ui-cyan)', CN: 'var(--ui-red)', DEC: 'var(--ui-purple)', '?': 'var(--ui-text-tertiary)' }
const normName = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
// OpenRouter's /providers list: headquarters country and datacenters, by normalised name. Filled
// by loadProviderInfo().
let PROVIDER_HQ = {}
const EU_CODES = new Set(['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'])
const countryRegion = code => (!code ? null : code === 'US' || code === 'CN' ? code : EU_CODES.has(code) ? 'EU' : code)
// OpenRouter's headquarters country decides; the curated table only covers providers OpenRouter
// gives no country for (and the first paint before the list has loaded).
// except Chinese companies that OpenRouter lists under their Singapore entity: they count as China.
const CHINA_ORIGIN = new Set(['zai', 'zhipu', 'zhipuai', 'moonshot', 'moonshotai', 'minimax', 'alibaba', 'alibabacloud', 'siliconflow', 'seed', 'bytedance', 'volcengine'])
const regionOf = name => (CHINA_ORIGIN.has(normName(name)) ? 'CN' : countryRegion((PROVIDER_HQ[normName(name)] || {}).hq) || PROVIDER_REGION[normName(name)] || '?')
// "Chinese company, OpenRouter lists Singapore" when the two disagree; null otherwise
const originNote = name => {
  const hq = (PROVIDER_HQ[normName(name)] || {}).hq
  return CHINA_ORIGIN.has(normName(name)) && hq && hq !== 'CN' ? 'Chinese company, OpenRouter lists ' + (REGION_LABEL[hq] || hq) : null
}
const regionColor = r => REGION_COLOR[r] || 'var(--ui-yellow)'
const slugOf = tag => String(tag || '').split('/')[0]
// Same weighting as loadCheapestEndpoint: cache re-reads dominate this user's traffic.
const blendedPrice = e => ((e.cache != null ? e.cache : e.in) * 20 + e.in + e.out * 0.1) / 21.1

async function loadRouting(profiles) {
  const rows = []
  let since = null
  let recording = false
  let reachable = false
  await Promise.all(
    (profiles || [{ name: 'default', isDefault: true }]).map(async p => {
      try {
        const q = '/api/plugins/hermetic/routing?days=' + DEFAULT_DAYS + (p.isDefault ? '' : '&profile=' + encodeURIComponent(p.name))
        const r = await api({ path: q })
        if (!r || !Array.isArray(r.rows)) return
        reachable = true
        if (r.recording) recording = true
        if (r.since != null && (since == null || r.since < since)) since = r.since
        for (const row of r.rows) rows.push({ ...row, profile: p.name })
      } catch {
        /* route missing on this profile's backend */
      }
    })
  )
  return { rows, since, recording, reachable }
}

// background (auxiliary) task routing status, served by the backend plugin (default profile)
// Daily billed totals kept by the backend (snapshotted after OpenRouter calls, also when the
// desktop app is closed, e.g. bot traffic through the gateway).
async function loadBilledHistory() {
  try {
    const r = await api({ path: '/api/plugins/hermetic/billed' })
    return (r && r.days) || {}
  } catch {
    return {}
  }
}

// Hermes internals the backend plugin could not find (a Hermes update renamed them); fallbacks run.
async function loadHealth() {
  try {
    const r = await api({ path: '/api/plugins/hermetic/health' })
    return (r && r.missing) || []
  } catch {
    return []
  }
}

async function loadAux(profile) {
  try {
    const r = await api(profileReq(profile, { path: '/api/plugins/hermetic/aux-routing' }))
    return r && Array.isArray(r.tasks) ? r : null
  } catch {
    return null
  }
}

async function loadProviderInfo() {
  const cached = sget('providers', null)
  const use = v => {
    PROVIDER_HQ = v || {}
    return PROVIDER_HQ
  }
  if (cached && Date.now() - cached.t < PRICES_TTL_MS && cached.v) return use(cached.v)
  try {
    const res = await fetch('https://openrouter.ai/api/v1/providers')
    if (!res.ok) throw new Error(String(res.status))
    const body = await res.json()
    const v = {}
    for (const p of (body && body.data) || []) {
      if (!p || !p.name) continue
      v[normName(p.name)] = { hq: typeof p.headquarters === 'string' ? p.headquarters.toUpperCase() : null, dcs: Array.isArray(p.datacenters) ? p.datacenters : [] }
    }
    sset('providers', { t: Date.now(), v })
    return use(v)
  } catch {
    return use(cached && cached.v)
  }
}

async function loadEndpoints(models) {
  const out = {}
  await Promise.all(
    models.map(async model => {
      const key = 'endpoints:' + model
      const cached = sget(key, null)
      if (cached && Date.now() - cached.t < PRICES_TTL_MS && Array.isArray(cached.v)) {
        out[model] = cached.v
        return
      }
      try {
        const res = await fetch('https://openrouter.ai/api/v1/models/' + model + '/endpoints')
        if (!res.ok) throw new Error(String(res.status))
        const body = await res.json()
        const list = ((body && body.data && body.data.endpoints) || [])
          .filter(e => e && e.pricing && e.tag)
          .map(e => ({
            tag: e.tag,
            name: e.provider_name || e.tag,
            quant: e.quantization && e.quantization !== 'unknown' ? e.quantization : null,
            uptime: e.uptime_last_1d != null ? num(e.uptime_last_1d) : null,
            status: e.status,
            in: parseFloat(e.pricing.prompt) * 1e6,
            out: parseFloat(e.pricing.completion) * 1e6,
            cache: e.pricing.input_cache_read != null ? parseFloat(e.pricing.input_cache_read) * 1e6 : null
          }))
          .filter(e => isFinite(e.in) && isFinite(e.out))
        out[model] = list
        sset(key, { t: Date.now(), v: list })
      } catch {
        out[model] = cached && Array.isArray(cached.v) ? cached.v : []
      }
    })
  )
  return out
}

// OpenRouter's public list of zero-retention endpoints, as "model|provider" keys.
async function loadZdr() {
  const cached = sget('zdr', null)
  if (cached && Date.now() - cached.t < PRICES_TTL_MS && Array.isArray(cached.v)) return new Set(cached.v)
  try {
    const res = await fetch('https://openrouter.ai/api/v1/endpoints/zdr')
    if (!res.ok) throw new Error(String(res.status))
    const body = await res.json()
    const v = Array.from(new Set(((body && body.data) || []).filter(e => e && e.model_id && e.provider_name).map(e => e.model_id + '|' + normName(e.provider_name))))
    if (!v.length) throw new Error('empty')
    sset('zdr', { t: Date.now(), v })
    return new Set(v)
  } catch {
    return cached && Array.isArray(cached.v) ? new Set(cached.v) : null
  }
}

// Price one aggregated routing row. The upstream name maps to the provider's cheapest variant for
// that model (the response does not say which quantisation served it); falls back to list price.
function routingRowCost(r, endpoints, prices) {
  const eps = (endpoints && endpoints[r.model]) || []
  const mine = eps.filter(e => normName(e.name) === normName(r.upstream)).sort((a, b) => blendedPrice(a) - blendedPrice(b))
  const p = mine[0] || (prices && prices[r.model]) || null
  if (!p) return { usd: 0, priced: false }
  const usd = (r.input * p.in + r.output * p.out + r.cache * (p.cache != null ? p.cache : p.in)) / 1e6
  return { usd, priced: !!mine[0] }
}

function parseAccountLines(lines) {
  if (!lines || !lines.length) return null
  const text = lines.join('\n')
    if (!/openrouter/i.test(text)) return null
    const limitM = text.match(/\$([\d,.]+) of \$([\d,.]+) remaining/)
    return {
      t: Date.now(),
      total: money(/API key usage: \$([\d,.]+) total/, text),
      today: money(/\$([\d,.]+) today/, text),
      week: money(/\$([\d,.]+) this week/, text),
      month: money(/\$([\d,.]+) this month/, text),
      balance: money(/Credits balance: \$([\d,.]+)/, text),
      remaining: limitM ? parseFloat(limitM[1].replace(/,/g, '')) : null,
      limit: limitM ? parseFloat(limitM[2].replace(/,/g, '')) : null
    }
}

let backendPatched = true

async function loadAccount(sid) {
  for (const path of ['/api/plugins/hermetic/account/usage', '/api/account/usage']) {
    try {
      const r = await api({ path, timeoutMs: 20_000 })
      if (r && Array.isArray(r.lines)) {
        backendPatched = true
        const parsed = parseAccountLines(r.lines)
        if (parsed) return parsed
        break
      }
    } catch {
      /* try the next source */
    }
    backendPatched = false
  }
  if (!sid) return null
  try {
    const r = await host.request('session.usage', { session_id: sid }, 20_000)
    const u = (r && (r.usage || r.result || r)) || {}
    return parseAccountLines(Array.isArray(u.account_lines) ? u.account_lines : [])
  } catch {
    return null
  }
}

// ---- pricing math -----------------------------------------------------------

// Exact OpenRouter id first; otherwise the same model under another vendor prefix or casing, as a
// custom endpoint names it ("deepinfra/DeepSeek-V4-Pro" -> "deepseek/deepseek-v4-pro").
let priceTail = null
let priceTailOf = null
const priceIdOf = (prices, model) => {
  if (!model || !prices) return null
  if (prices[model]) return model
  if (priceTailOf !== prices) {
    priceTail = new Map()
    priceTailOf = prices
    for (const id of Object.keys(prices)) {
      const t = id.split('/').pop().toLowerCase()
      if (!priceTail.has(t)) priceTail.set(t, id)
    }
  }
  return priceTail.get(String(model).split('/').pop().toLowerCase()) || null
}
const priceOf = (prices, model) => { const id = priceIdOf(prices, model); return id ? prices[id] : null }
const costAt = (p, input, output, cache) =>
  p ? (num(input) * p.in + num(output) * p.out + num(cache) * (p.cache != null ? p.cache : p.in)) / 1e6 : null

// ---- live ticks -------------------------------------------------------------

const live = new Map() // sid -> { samples: [{t, input, output, cache, model}], last }

const RESETS_MAX = 3000
let resets = []
// Storage is attached in register(); the module body runs before that.
function initResets() {
  resets = sget('resets', null) || []
  if (!sget('resetsSince', null)) sset('resetsSince', Date.now())
}

function detectReset(sid, prev, cur, usage) {
  if (!prev) return
  const dIn = cur.input - prev.input
  const dCache = cur.cache - prev.cache
  const dCalls = num(usage.calls) - num(prev.raw && prev.raw.calls)
  if (dCalls <= 0 || dIn <= 0) return
  const ctx = num(usage.context_used) || Math.max(dCache, prev.cache / Math.max(num(prev.raw && prev.raw.calls), 1))
  if (ctx < 20_000) return
  // A cold call re-sends the context as fresh input while cache reads stay flat.
  if (dIn < ctx * 0.5 || dCache > ctx * 0.1) return
  const compacted = num(usage.compressions) > num(prev.raw && prev.raw.compressions)
  resets.push({ t: cur.t, sid, cause: compacted ? 'compaction' : 'swap', tokens: dIn, model: cur.model, calls: num(usage.calls), cache: cur.cache, input: cur.input })
  if (resets.length > RESETS_MAX) resets = resets.slice(-RESETS_MAX)
  sset('resets', resets)
}

function recordTick(sid, usage) {
  if (!sid || !usage) return
  const e = live.get(sid) || { samples: [], last: null }
  const s = { t: Date.now(), input: num(usage.input), output: num(usage.output), cache: num(usage.cache_read_tokens), model: usage.model || '', raw: usage }
  detectReset(sid, e.last, s, usage)
  e.samples.push(s)
  const cutoff = Date.now() - LIVE_WINDOW_MS
  while (e.samples.length > 2 && e.samples[0].t < cutoff) e.samples.shift()
  e.last = s
  live.set(sid, e)
}

function liveRates(prices, fallbackModel) {
  const now = Date.now()
  const out = []
  for (const [sid, e] of live) {
    if (!e.last || now - e.last.t > LIVE_WINDOW_MS) continue
    const first = e.samples[0]
    const lastS = e.last
    const hours = Math.max((lastS.t - first.t) / 3600_000, 1 / 60)
    const p = priceOf(prices, lastS.model || fallbackModel)
    if (!p) continue
    const cacheDelta = Math.max(0, lastS.cache - first.cache)
    const inDelta = Math.max(0, lastS.input - first.input)
    const outDelta = Math.max(0, lastS.output - first.output)
    const spent = costAt(p, inDelta, outDelta, cacheDelta)
    if (spent == null) continue
    out.push({ sid, rate: spent / hours, usage: lastS.raw, recentMs: now - lastS.t })
  }
  return out
}

// ---- model ------------------------------------------------------------------

function computeModel(data, period, hoverDay, prices, threshold, defaultModel, billed) {
  const pdata = (data.periods && data.periods[period]) || { aux: new Map(), byModel: new Map(), total: 0 }
  const days = period === 'today' ? lastNDays(1) : period === '7d' ? lastNDays(7) : lastNDays(DEFAULT_DAYS)
  const dayset = new Set(days)
  const focusDays = hoverDay ? new Set([hoverDay]) : dayset
  const start = dayStart(hoverDay || days[0])
  const end = hoverDay ? dayStart(hoverDay) + 86400 : Infinity

  const billedMap = billed || {}
  const series = days.map(d => ({ ...(data.daily.get(d) || { day: d, cost: 0, input: 0, output: 0, cache: 0, calls: 0, sessions: 0 }), billed: billedMap[d] != null ? billedMap[d] : null }))
  const periodCost = series.filter(r => focusDays.has(r.day)).reduce((a, r) => a + r.cost, 0)
  const periodCalls = series.filter(r => focusDays.has(r.day)).reduce((a, r) => a + r.calls, 0)
  const periodSessions = series.filter(r => focusDays.has(r.day)).reduce((a, r) => a + r.sessions, 0)

  const all30 = lastNDays(DEFAULT_DAYS).map(d => (data.daily.get(d) || { cost: 0 }).cost)
  const today = dateStr(new Date())
  const typical = median(all30.slice(0, -1))
  const todayCost = (data.daily.get(today) || { cost: 0 }).cost

  const sessions = data.sessions.filter(s => s.last >= start && s.last < end && s.calls > 0)
  const byId = new Map(sessions.map(s => [s.id, s]))
  const enriched = sessions
    .map(s => {
      const p = priceOf(prices, s.model)
      const window = p && p.ctx ? p.ctx : null
      const ctxPerCall = s.calls ? (s.cache + s.input) / s.calls : 0
      const hours = Math.max((s.last - s.started) / 3600, 1 / 12)
      const hit = s.input + s.cache > 0 ? (s.cache / (s.input + s.cache)) * 100 : null
      const kind = s.parent || /^subagent\b/i.test(s.title) ? 'subagent' : 'chat'
      return {
        ...s,
        price: p,
        window,
        ctxPerCall,
        ctxShare: window ? ctxPerCall / window : null,
        ratePerHour: s.cost / hours,
        hit,
        kind,
        parentInList: s.parent && byId.has(s.parent)
      }
    })
    .sort((a, b) => b.cost - a.cost)

  const totalSessCost = enriched.reduce((a, s) => a + s.cost, 0)
  const top = enriched[0] || null

  // composition at list price
  let compCache = 0
  let compOut = 0
  let compIn = 0
  let cacheSaved = 0
  let atDefault = 0
  let cacheRead = 0
  let fresh = 0
  const pDefault = priceOf(prices, defaultModel)
  for (const s of enriched) {
    const p = s.price
    cacheRead += s.cache
    fresh += s.input
    if (p) {
      compCache += (s.cache * (p.cache != null ? p.cache : p.in)) / 1e6
      compOut += (s.output * p.out) / 1e6
      compIn += (s.input * p.in) / 1e6
      if (p.cache != null) cacheSaved += (s.cache * (p.in - p.cache)) / 1e6
    }
    if (pDefault) atDefault += costAt(pDefault, s.input, s.output, s.cache)
  }
  const compTotal = compCache + compOut + compIn
  const kinds = { chat: 0, subagent: 0 }
  for (const s of enriched) kinds[s.kind] += s.cost

  // aux tasks (background review, compression, titles) on paid models
  let auxCost = 0
  let auxIn = 0
  let auxOut = 0
  for (const [, tasks] of pdata.aux) {
    for (const [, c] of tasks) {
      auxCost += c.cost
      auxIn += c.input
      auxOut += c.output
    }
  }
  const auxShare = periodCost > 0 ? auxCost / periodCost : 0

  // Delegate runs and hidden sessions are not listed by the sessions route; their
  // cost is the gap between the analytics total and what the listed sessions add up to.
  const remainder = hoverDay || data.sessionsComplete ? 0 : Math.max(0, periodCost - totalSessCost - auxCost)
  if (remainder > 0.01) {
    enriched.push({
      id: '__subagents',
      title: 'subagents',
      synthetic: true,
      kind: 'subagent',
      cost: remainder,
      calls: 0,
      ctxShare: null,
      ratePerHour: 0,
      hit: null,
      model: '',
      price: null
    })
    enriched.sort((a, b) => b.cost - a.cost)
    kinds.subagent += remainder
  }

  // bloat: worst session against its window and the compaction threshold
  const bloat = enriched.filter(s => s.ctxShare != null).sort((a, b) => b.ctxShare - a.ctxShare)[0] || null
  const bloatOver = bloat ? bloat.ctxShare >= threshold : false

  // improvements (all from stored numbers)
  const flash = prices['deepseek/deepseek-v4.1-flash'] || pDefault
  const improvements = []
  if (auxCost > 0 && flash) {
    const atFlash = costAt(flash, auxIn, auxOut, 0)
    const save = auxCost - atFlash
    if (save > 0.05)
      improvements.push({
        id: 'aux',
        label: 'Aux tasks on a flash model',
        save,
        approx: false,
        action: 'apply',
        change: { kind: 'aux', model: 'deepseek/deepseek-v4.1-flash' }
      })
  }
  const target = Math.min(0.25, threshold / 2)
  let compactSave = 0
  for (const s of enriched) {
    if (!s.price || !s.window || s.ctxShare == null || s.ctxShare <= target) continue
    const factor = 1 - (target * s.window) / s.ctxPerCall
    compactSave += ((s.cache * (s.price.cache != null ? s.price.cache : s.price.in)) / 1e6) * factor
  }
  if (compactSave > 0.05 && threshold > target)
    improvements.push({
      id: 'compact',
      label: 'Compact at ' + Math.round(target * 100) + '% on long chats',
      save: compactSave,
      approx: true,
      action: 'apply',
      change: { kind: 'threshold', value: target }
    })
  improvements.sort((a, b) => b.save - a.save)

  // cache resets from live ticks (runtime sid → stored session by matching counters)
  const since = start * 1000
  const until = end === Infinity ? Infinity : end * 1000
  const periodResets = resets.filter(r => r.t >= since && r.t < until)
  const sidMap = new Map()
  for (const r of periodResets) {
    if (sidMap.has(r.sid)) continue
    const latest = resets.filter(q => q.sid === r.sid).sort((a, b) => b.t - a.t)[0]
    const match = enriched.find(x => !x.synthetic && x.calls >= latest.calls && Math.abs(x.cache - latest.cache) <= Math.max(latest.cache * 0.05, 50_000) && x.input >= latest.input * 0.95)
    sidMap.set(r.sid, match ? match.id : null)
  }
  let swaps = 0
  let compactions = 0
  let toll = 0
  for (const r of periodResets) {
    if (r.cause === 'swap') swaps++
    else compactions++
    const p = priceOf(prices, r.model) || (top ? top.price : null)
    const tollEach = p ? (r.tokens * (p.in - (p.cache != null ? p.cache : p.in))) / 1e6 : 0
    toll += tollEach
    const id = sidMap.get(r.sid)
    const sess = id ? enriched.find(x => x.id === id) : null
    if (sess) {
      sess.resets = (sess.resets || 0) + 1
      if (r.cause === 'swap') sess.swaps = (sess.swaps || 0) + 1
      sess.toll = (sess.toll || 0) + tollEach
    }
  }
  const resetsSince = sget('resetsSince', null)

  return {
    days,
    series,
    resets: { swaps, compactions, toll, since: resetsSince, total: periodResets.length },
    periodCost,
    periodCalls,
    periodSessions,
    typical,
    todayCost,
    sessions: enriched,
    totalSessCost,
    top,
    composition: { cache: compCache, out: compOut, in: compIn, total: compTotal },
    kinds,
    auxCost,
    auxShare,
    bloat,
    bloatOver,
    improvements,
    cache: {
      hit: cacheRead + fresh > 0 ? (cacheRead / (cacheRead + fresh)) * 100 : null,
      read: cacheRead,
      fresh,
      saved: cacheSaved,
      atDefault: pDefault ? atDefault : null
    },
    byModel: pdata.byModel,
    auxByModel: pdata.aux
  }
}

const periodHours = period => {
  if (period === '7d') return 7 * 24
  if (period === '30d') return DEFAULT_DAYS * 24
  // OpenRouter's "today" is a UTC day; a one-hour floor keeps the first minutes from spiking.
  const d = new Date()
  return Math.max((d.getUTCHours() * 60 + d.getUTCMinutes()) / 60, 1)
}
const periodSpend = (data, account, period) => {
  if (account) {
    const v = period === 'today' ? account.today : period === '7d' ? account.week : account.month
    if (v != null) return v
  }
  if (!data) return 0
  const days = period === 'today' ? lastNDays(1) : period === '7d' ? lastNDays(7) : lastNDays(DEFAULT_DAYS)
  return days.reduce((a, d) => a + (data.daily.get(d) || { cost: 0 }).cost, 0)
}

// ---- data hook --------------------------------------------------------------

function useMeterData() {
  const [state, setState] = useState({ loading: true, error: null, data: null, prices: {}, threshold: 0.5, retries: 0, yaml: '', account: null })
  const busy = useRef(false)
  const timer = useRef(null)
  const sidRef = useRef(null)
  const profileRef = useRef('default')

  const refresh = async () => {
    if (busy.current) return
    busy.current = true
    const profile = profileRef.current
    try {
      const [profiles, prices, yaml] = await Promise.all([loadProfiles(), loadPrices(), loadConfigRaw(profile)])
      // "profile": only the focused chat's profile; "all": every profile added up
      const scope = sget('scope', 'profile') === 'all' ? 'all' : 'profile'
      const scoped = scope === 'all' ? profiles : profiles.filter(p => p.name === profile)
      const shown = scoped.length ? scoped : profiles
      const [analytics, sessionsResult, retries, account, routingAll, aux, billedHistory, health] = await Promise.all([
        loadAllAnalytics(shown, prices),
        loadSessions(profiles),
        loadRetries(lastNDays(DEFAULT_DAYS)[0]),
        loadAccount(sidRef.current),
        loadRouting(profiles),
        loadAux(profile),
        loadBilledHistory(),
        loadHealth()
      ])
      for (const x of sessionsResult.sessions) {
        if (!x.cost && x.input + x.output + x.cache > 0) {
          const c = costAt(priceOf(prices, x.model), x.input, x.output, x.cache)
          if (c) { x.cost = c; x.estimated = true }
        }
      }
      const inScope = new Set(shown.map(p => p.name))
      const routing = { ...routingAll, rows: routingAll.rows.filter(r => inScope.has(r.profile)) }
      // OpenRouter-only parts show for a profile that routes through OpenRouter (or, on "auto",
      // has recorded OpenRouter calls); with all profiles, also when any profile has history.
      let orCfg = configUsesOpenRouter(yaml)
      if (orCfg == null) {
        // "auto" or unreadable: trust where this profile's latest chat was actually billed
        const latest = sessionsResult.sessions.filter(x => x.profile === profile && (x.provider || x.base)).sort((a, b) => b.last - a.last)[0]
        if (latest) orCfg = /openrouter/i.test(latest.provider + latest.base)
      }
      const orProfile = orCfg === true || (orCfg == null && routingAll.rows.some(r => r.profile === profile))
      const orNames = new Set(routingAll.rows.map(r => r.profile).filter(Boolean))
      if (orCfg === true) orNames.add(profile)
      const orAny = scope === 'all' ? orProfile || routingAll.rows.length > 0 || !!account : orProfile
      // OpenRouter bills the whole key, so the bill is compared with every profile that uses it
      const orList = profiles.filter(p => orNames.has(p.name))
      const sameSet = orList.length === shown.length && orList.every(p => inScope.has(p.name))
      const orAnalytics = account && orList.length && !sameSet ? await loadAllAnalytics(orList, prices) : null
      const topModel = (sessionsResult.sessions.slice().sort((a, b) => b.cost - a.cost)[0] || {}).model || ''
      const routeModels = Array.from(
        new Set(
          routing.rows.map(r => r.model).concat(sessionsResult.sessions.slice().sort((a, b) => b.cost - a.cost).slice(0, 3).map(x => x.model)).filter(Boolean)
        )
      )
      const [cheapest, endpoints] = orAny ? await Promise.all([loadCheapestEndpoint(topModel), loadEndpoints(routeModels)]) : [null, {}]
      {
        const local = sget('billed', null) || {}
        let changed = false
        for (const [day, usd] of Object.entries(billedHistory || {})) {
          const v = num(usd)
          if (v > num(local[day])) {
            local[day] = v
            changed = true
          }
        }
        if (changed) sset('billed', local)
      }
      const acc = account || null
      if (acc && acc.today != null) {
        const utcDay = new Date().toISOString().slice(0, 10)
        const billed = sget('billed', null) || {}
        billed[utcDay] = acc.today
        const keys = Object.keys(billed).sort()
        for (const k of keys.slice(0, Math.max(0, keys.length - 60))) delete billed[k]
        sset('billed', billed)
      }
      setState(s => ({
        loading: false,
        error: null,
        cheapest,
        data: { ...analytics, sessions: sessionsResult.sessions.filter(x => inScope.has(x.profile)), sessionsComplete: sessionsResult.complete, routing, endpoints, aux, health,
          orDaily: orAnalytics ? orAnalytics.daily : null, providerName: providerLabel(yaml) },
        scope,
        profileCount: profiles.length,
        prices,
        threshold: parseThreshold(yaml),
        retries,
        yaml,
        profile,
        profileLabel: (profiles.find(p => p.name === profile) || {}).label || profile,
        orProfile,
        orAny,
        // the OpenRouter account card belongs to OpenRouter profiles (or to the all-profiles total)
        account: scope === 'all' || orProfile ? account || s.account : null
      }))
    } catch (e) {
      setState(s => ({ ...s, loading: false, error: (e && e.message) || 'load failed' }))
    } finally {
      busy.current = false
    }
  }

  const focusedSid = useValue(host.state.focusedSessionId)
  const activeSid = useValue(host.state.activeSessionId)
  sidRef.current = focusedSid || activeSid || null
  const focusedProfile = useValue(host.state.focusedSessionProfile)
  const activeProfile = useValue(host.state.profile)
  profileRef.current = String(focusedProfile || activeProfile || 'default').trim() || 'default'

  // switching to a chat in another profile reloads that profile's config and background routing
  useEffect(() => {
    if (state.profile && state.profile !== profileRef.current) refresh()
  }, [profileRef.current])

  useEffect(() => {
    if (sidRef.current && !state.account) refresh()
  }, [focusedSid, activeSid])

  useEffect(() => {
    refresh()
    const iv = setInterval(refresh, REFRESH_MS)
    const offDone = host.onEvent('message.complete', () => {
      clearTimeout(timer.current)
      timer.current = setTimeout(refresh, 2500)
    })
    return () => {
      clearInterval(iv)
      clearTimeout(timer.current)
      if (offDone) offDone()
    }
  }, [])

  const setScope = v => {
    sset('scope', v)
    setState(s => ({ ...s, scope: v }))
    if (busy.current) setTimeout(refresh, 900)
    else refresh()
  }
  return { ...state, refresh, setScope }
}

function useLive(prices, fallbackModel) {
  const [, bump] = useState(0)
  useEffect(() => {
    const off = host.onEvent('session.usage', payload => {
      if (!payload || !payload.usage) return
      recordTick(payload.session_id || payload.sessionId || payload.sid, payload.usage)
      bump(x => x + 1)
    })
    const iv = setInterval(() => bump(x => x + 1), 5000)
    return () => {
      if (off) off()
      clearInterval(iv)
    }
  }, [])
  return liveRates(prices, fallbackModel)
}

// ---- visuals ----------------------------------------------------------------

const C = {
  text: 'var(--ui-text-primary)',
  sub: 'var(--ui-text-secondary)',
  dim: 'var(--ui-text-tertiary)',
  faint: 'var(--ui-text-quaternary)',
  accent: 'var(--ui-accent)',
  stroke: 'var(--ui-stroke-secondary)',
  track: 'var(--ui-bg-tertiary)',
  warn: 'var(--ui-yellow)',
  bad: 'var(--ui-red)',
  ok: 'var(--ui-green)'
}

const Dot = ({ tone }) =>
  el('span', {
    'aria-hidden': true,
    style: {
      width: 7,
      height: 7,
      borderRadius: 9999,
      flex: 'none',
      display: 'inline-block',
      background: tone === 'warn' ? C.warn : tone === 'bad' ? C.bad : tone === 'ok' ? C.ok : C.faint
    }
  })

const Spark = ({ values, tone, marks }) => {
  const W = 42
  const H = 12
  const max = Math.max.apply(null, values.concat([0.0001]))
  const pts = values.map((v, i) => {
    const x = values.length > 1 ? 1 + (i * (W - 2)) / (values.length - 1) : W / 2
    const y = H - 1.5 - (v / max) * (H - 3)
    return [x, y]
  })
  const color = tone === 'warn' ? C.warn : tone === 'bad' ? C.bad : C.accent
  const last = pts[pts.length - 1]
  // Provider swaps as red stripes at their moment on the 7-day line: the x axis runs from the
  // start of the first day to now, so a stripe lands within the right day at about hour resolution.
  const dayMs = 86400_000
  const first = new Date()
  first.setHours(0, 0, 0, 0)
  const t0 = first.getTime() - (values.length - 1) * dayMs
  const span = Math.max(Date.now() - t0, 1)
  const stripes = (marks || [])
    .filter(m => m.t >= t0)
    .map(m => 1 + ((m.t - t0) / span) * (W - 2))
  return el(
    'svg',
    { width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, 'aria-hidden': true, style: { display: 'block', flexShrink: 0 } },
    stripes.map((x, i) => el('line', { key: 'm' + i, x1: x.toFixed(1), x2: x.toFixed(1), y1: 0, y2: H, stroke: C.bad, strokeWidth: 1, strokeOpacity: 0.9 })),
    el('polyline', {
      points: pts.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' '),
      fill: 'none',
      stroke: color,
      strokeWidth: 1.5,
      strokeLinejoin: 'round',
      strokeLinecap: 'round'
    }),
    last ? el('circle', { cx: last[0], cy: last[1], r: 1.8, fill: color }) : null
  )
}

const Bars = ({ series, hoverDay, onHover, onPin, pinned }) => {
  const topOf = r => (r.billed != null ? r.billed : r.est != null ? r.est : r.cost)
  const max = Math.max.apply(null, series.map(r => Math.max(r.cost, topOf(r))).concat([0.0001]))
  const n = series.length
  const gap = n > 10 ? 2 : 6
  const H = 56
  return el(
    'div',
    { style: { display: 'flex', alignItems: 'flex-end', gap, height: H, marginTop: 10 }, onMouseLeave: () => onHover(null) },
    series.map(r => {
      const h = r.cost > 0 ? Math.max(3, Math.round((r.cost / max) * (H - 2))) : 2
      const top = topOf(r)
      const estimated = r.billed == null && r.est != null
      const extra = top > r.cost ? Math.max(2, Math.round(((top - r.cost) / max) * (H - 2))) : 0
      const active = hoverDay ? hoverDay === r.day : false
      const dimmed = hoverDay && !active
      const op = dimmed ? 0.3 : pinned === r.day || active ? 1 : 0.75
      return el(
        'div',
        {
          key: r.day,
          onMouseEnter: () => onHover(r.day),
          onClick: () => onPin(r.day),
          title: dayLabel(r.day) + ', list ' + fmtUsd(r.cost) + (r.billed != null ? ', billed ' + fmtUsd(r.billed) + ' (UTC day)' : estimated ? ', billed ≈ ' + fmtUsd(r.est) + ' (estimated)' : '') + ', ' + r.calls + ' calls',
          style: { flex: 1, height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', cursor: 'pointer' }
        },
        extra > 0
          ? el('div', {
              style: {
                width: '100%',
                height: extra,
                borderRadius: '2px 2px 0 0',
                background: C.warn,
                opacity: estimated ? op * 0.5 : op,
                transition: 'opacity 120ms ease, height 200ms ease'
              }
            })
          : null,
        el('div', {
          style: {
            width: '100%',
            height: h,
            borderRadius: extra > 0 ? '0 0 2px 2px' : 2,
            background: r.cost > 0 ? C.accent : C.track,
            opacity: r.cost > 0 ? op : 1,
            transition: 'opacity 120ms ease, height 200ms ease'
          }
        })
      )
    })
  )
}

const Track = ({ value, tick, tone, height }) =>
  el(
    'div',
    { style: { position: 'relative', height: height || 4, borderRadius: 2, background: C.track, overflow: 'visible' } },
    el('div', {
      style: {
        position: 'absolute',
        left: 0,
        top: 0,
        bottom: 0,
        width: Math.max(0, Math.min(100, num(value) * 100)) + '%',
        borderRadius: 2,
        background: tone === 'warn' ? C.warn : tone === 'bad' ? C.bad : C.accent
      }
    }),
    tick != null
      ? el('div', {
          style: {
            position: 'absolute',
            left: Math.max(0, Math.min(100, tick * 100)) + '%',
            top: -3,
            bottom: -3,
            width: 1,
            background: C.dim
          }
        })
      : null
  )

// Points are numbers or { v, est }. Drawn as one uniform line; whether a point is estimated is
// reported in the cell tooltip, not in the stroke.
const trendVal = x => (typeof x === 'number' ? x : x.v)
const trendEst = x => typeof x !== 'number' && !!x.est
const TrendLine = ({ values, inline }) => {
  const W = 48
  const H = 14
  const nums = values.map(trendVal)
  const max = Math.max.apply(null, nums.concat([1]))
  const min = Math.min.apply(null, nums.concat([1]))
  const span = Math.max(max - min, 0.1)
  const pts = nums.map((v, i) => [1 + (i * (W - 2)) / Math.max(values.length - 1, 1), 1.5 + (1 - (v - min) / span) * (H - 3)])
  const last = pts[pts.length - 1]
  return el(
    'svg',
    { width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, 'aria-hidden': true, style: { display: 'inline-block', verticalAlign: 'middle', marginLeft: inline ? 0 : 8 } },
    el('polyline', { points: pts.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' '), fill: 'none', stroke: C.warn, strokeWidth: 1.5, strokeLinejoin: 'round', strokeLinecap: 'round' }),
    el('circle', { cx: last[0], cy: last[1], r: 1.8, fill: C.warn })
  )
}

// Day-over-day change of the drift ratio. Falling drift is good (green), rising is red.
const DriftDelta = ({ values }) => {
  const n = values.length
  const d = trendVal(values[n - 1]) - trendVal(values[n - 2])
  const flat = Math.abs(d) < 0.05
  const color = flat ? C.dim : d < 0 ? C.ok : C.bad
  return el(
    'span',
    { style: { display: 'inline-flex', alignItems: 'center', gap: 4, color, fontVariantNumeric: 'tabular-nums' } },
    flat
      ? el('span', { style: { opacity: 0.8 } }, '–')
      : el(
          'svg',
          { width: 8, height: 8, viewBox: '0 0 8 8', 'aria-hidden': true, style: { display: 'block', transform: d < 0 ? 'none' : 'rotate(180deg)' } },
          el('path', { d: 'M1 2.5 L4 6 L7 2.5', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' })
        ),
    el('span', null, Math.abs(d).toFixed(1) + '×')
  )
}

const Cell = ({ tone, label, value, sub, tip }) =>
  el(
    Tip,
    { label: tip || '' },
    el(
      'div',
      {
        style: {
          background: 'var(--ui-bg-tertiary)',
          borderRadius: 6,
          padding: '9px 10px',
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 4
        }
      },
      el(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: C.sub } },
        el(Dot, { tone }),
        el('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, label)
      ),
      el(
        'div',
        { style: { fontSize: 14, fontWeight: 500, color: C.text, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } },
        value,
        sub ? (typeof sub === 'string' ? el('span', { style: { fontSize: 11, fontWeight: 400, color: C.dim, marginLeft: 6 } }, sub) : sub) : null
      )
    )
  )

const niceStep = (max, maxTicks) => {
  const raw = max / maxTicks
  const pow = Math.pow(10, Math.floor(Math.log10(raw)))
  for (const m of [1, 2, 2.5, 5, 10]) if (m * pow >= raw) return m * pow
  return 10 * pow
}

const Scatter = ({ sessions, threshold, hover, onHover, currentId }) => {
  const pts = sessions.filter(p => !p.synthetic && p.calls > 0 && p.ctxPerCall > 0)
  if (pts.length < 2) return null
  const W = 368
  const H = 196
  const L = 38
  const R = 10
  const T = 12
  const B = 24
  const maxR = 20
  const maxC = Math.max.apply(null, pts.map(p => p.cost))
  const r = c => 4 + Math.sqrt(c / maxC) * (maxR - 4)
  const maxX = Math.max.apply(null, pts.map(p => p.ctxPerCall))
  const maxY = Math.max(Math.max.apply(null, pts.map(p => p.ratePerHour)), 0.5)
  const x = v => L + maxR + (v / maxX) * (W - L - R - 2 * maxR)
  const y = v => T + maxR + (1 - v / maxY) * (H - T - B - 2 * maxR)
  const xStep = niceStep(maxX, 4)
  const xTicks = []
  for (let v = xStep; v <= maxX; v += xStep) xTicks.push(v)
  const yRef = [10, 5, 2, 1, 0.5, 0.25].find(v => v <= maxY * 0.9) || null
  const biggest = pts.reduce((a, p) => (p.cost > a.cost ? p : a), pts[0])
  const bursts = pts.filter(p => p.kind === 'subagent' && p.ratePerHour >= 1.5)
  const burstTop = bursts.length ? bursts.reduce((a, p) => (p.ratePerHour > a.ratePerHour ? p : a), bursts[0]) : null
  const bigLeft = x(biggest.ctxPerCall) > W / 2
  const label = p => p.title.replace(/^Subagent:\s*/i, '')
  return el(
    'svg',
    { width: '100%', viewBox: '0 0 ' + W + ' ' + H, 'aria-hidden': true, style: { display: 'block', marginBottom: 8 } },
    el('line', { x1: L, y1: H - B, x2: W, y2: H - B, stroke: C.stroke }),
    el('line', { x1: L, y1: T, x2: L, y2: H - B, stroke: C.stroke }),
    yRef != null ? el('line', { x1: L, y1: y(yRef), x2: W, y2: y(yRef), stroke: C.dim, strokeDasharray: '2 4', strokeOpacity: 0.7 }) : null,
    yRef != null ? el('text', { x: L - 5, y: y(yRef) + 3, fontSize: 10, fill: C.sub, textAnchor: 'end' }, '$' + yRef + '/h') : null,
    xTicks.map((v, i) => el('text', { key: i, x: x(v), y: H - 8, fontSize: 10, fill: C.faint, textAnchor: 'middle' }, fmtTok(v))),
    pts
      .slice()
      .sort((a, b) => b.cost - a.cost)
      .map(p => {
        const over = p.ctxShare != null && p.ctxShare >= threshold
        const fill = p.kind === 'subagent' ? C.warn : C.accent
        const hot = hover === p.id
        return el(
          'g',
          { key: p.id, onMouseEnter: () => onHover && onHover(p.id), onMouseLeave: () => onHover && onHover(null), style: { cursor: 'default' } },
          currentId === p.id
            ? el('circle', { cx: x(p.ctxPerCall), cy: y(p.ratePerHour), r: r(p.cost) + 4, fill: 'none', stroke: C.text, strokeWidth: 1.5, strokeOpacity: 0.9 })
            : null,
          el('circle', {
            cx: x(p.ctxPerCall),
            cy: y(p.ratePerHour),
            r: r(p.cost) + (hot ? 2 : 0),
            fill,
            fillOpacity: hover && !hot ? 0.35 : 0.72,
            stroke: over ? C.bad : (p.swaps || 0) >= 3 ? C.warn : hot ? C.text : fill,
            strokeWidth: over || hot || (p.swaps || 0) >= 3 ? 1.5 : 1,
            style: { transition: 'r 120ms, fill-opacity 120ms' }
          })
        )
      }),
    (() => {
      const p = hover ? pts.find(q => q.id === hover) : null
      if (!p) return null
      const line1 = trunc(label(p), 30)
      const line2 = fmtUsd(p.cost) + '\u2003' + fmtRate(p.ratePerHour) + '\u2003' + fmtTok(p.ctxPerCall) + '/call' + (p.resets ? '\u2003' + p.resets + ' resets' : p.hit != null ? '\u2003' + fmtPct(p.hit) + ' hit' : '')
      const w = Math.min(W - 8, Math.max(line1.length * 6.2, line2.length * 5.6) + 16)
      const cx = x(p.ctxPerCall)
      const cy = y(p.ratePerHour)
      const rr = r(p.cost)
      const left = Math.max(4, Math.min(cx - w / 2, W - w - 4))
      const top = cy - rr - 42 >= 0 ? cy - rr - 42 : Math.min(cy + rr + 8, H - 36)
      return el(
        'g',
        { style: { pointerEvents: 'none' } },
        el('rect', { x: left, y: top, width: w, height: 34, rx: 5, fill: 'var(--ui-bg-elevated, var(--ui-bg-tertiary))', stroke: C.stroke }),
        el('text', { x: left + 8, y: top + 13, fontSize: 11, fill: C.text, fontWeight: 500 }, line1),
        el('text', { x: left + 8, y: top + 27, fontSize: 10, fill: C.sub, fontVariantNumeric: 'tabular-nums' }, line2)
      )
    })(),
    el(
      'text',
      {
        x: Math.max(L + 30, Math.min(x(biggest.ctxPerCall), W - 30)),
        y: y(biggest.ratePerHour) - r(biggest.cost) - 6 > T + 10 ? y(biggest.ratePerHour) - r(biggest.cost) - 6 : y(biggest.ratePerHour) + r(biggest.cost) + 12,
        fontSize: 11,
        fill: C.text,
        textAnchor: 'middle'
      },
      trunc(label(biggest), 22)
    ),
    burstTop && burstTop !== biggest
      ? el('text', { x: x(burstTop.ctxPerCall) + r(burstTop.cost) + 8, y: y(burstTop.ratePerHour) + 4, fontSize: 11, fill: C.text }, bursts.length > 1 ? 'subagent bursts' : trunc(label(burstTop), 22))
      : null
  )
}

// ---- collapsible section -----------------------------------------------------

const Section = ({ id, title, right, children, openTick }) => {
  const [open, setOpen] = useState(() => !!sget('open:' + id, false))
  useEffect(() => { if (openTick) { setOpen(true); sset('open:' + id, true) } }, [openTick])
  const toggle = () => {
    setOpen(!open)
    sset('open:' + id, !open)
  }
  return el(
    'div',
    { style: { marginTop: 14 } },
    el(
      'button',
      {
        type: 'button',
        onClick: toggle,
        className: 'hover:text-(--ui-text-primary)',
        style: {
          display: 'flex',
          width: '100%',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '10px 0 0',
          background: 'transparent',
          border: 'none',
          borderTop: '1px solid ' + C.stroke,
          color: C.sub,
          fontSize: 11,
          cursor: 'pointer'
        }
      },
      el('span', null, title),
      el(
        'span',
        { style: { display: 'flex', alignItems: 'center', gap: 8, fontVariantNumeric: 'tabular-nums' } },
        right != null ? el('span', { style: { color: C.text } }, right) : null,
        el(
          'svg',
          { width: 12, height: 12, viewBox: '0 0 12 12', 'aria-hidden': true, style: { display: 'block', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 150ms' } },
          el('polyline', { points: '2.5,4.5 6,8 9.5,4.5', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' })
        )
      )
    ),
    open ? el('div', { style: { marginTop: 10 } }, children) : null
  )
}

// ---- apply (raw YAML edit, confirmed inline) ---------------------------------

function buildYamlChange(yaml, change) {
  const lines = String(yaml).split('\n')
  const diff = []
  if (change.kind === 'threshold') {
    const i = lines.findIndex(l => /^compression:\s*$/.test(l))
    if (i >= 0) {
      for (let j = i + 1; j < lines.length; j++) {
        if (/^[A-Za-z_]/.test(lines[j])) break
        const m = lines[j].match(/^(\s+threshold:\s*)([0-9.]+)(.*)$/)
        if (m) {
          diff.push({ from: lines[j], to: m[1] + change.value.toFixed(2) + m[3] })
          lines[j] = m[1] + change.value.toFixed(2) + m[3]
          return { yaml: lines.join('\n'), diff }
        }
      }
      diff.push({ from: null, to: '  threshold: ' + change.value.toFixed(2) })
      lines.splice(i + 1, 0, '  threshold: ' + change.value.toFixed(2))
      return { yaml: lines.join('\n'), diff }
    }
    diff.push({ from: null, to: 'compression:\n  threshold: ' + change.value.toFixed(2) })
    lines.push('', 'compression:', '  threshold: ' + change.value.toFixed(2))
    return { yaml: lines.join('\n'), diff }
  }
  if (change.kind === 'provider_only') {
    const block = ['  only:', '    - ' + change.value]
    const i = lines.findIndex(l => /^provider_routing:\s*$/.test(l))
    if (i >= 0) {
      let j = i + 1
      let onlyAt = -1
      for (; j < lines.length; j++) {
        if (/^[A-Za-z_]/.test(lines[j])) break
        if (/^\s{2}only:/.test(lines[j])) onlyAt = j
      }
      if (onlyAt >= 0) {
        let k = onlyAt + 1
        while (k < lines.length && /^\s{4}-/.test(lines[k])) k++
        const removed = lines.slice(onlyAt, k)
        diff.push({ from: removed.join('\n'), to: block.join('\n') })
        lines.splice(onlyAt, k - onlyAt, ...block)
        return { yaml: lines.join('\n'), diff }
      }
      diff.push({ from: null, to: block.join('\n') })
      lines.splice(i + 1, 0, ...block)
      return { yaml: lines.join('\n'), diff }
    }
    diff.push({ from: null, to: ['provider_routing:'].concat(block).join('\n') })
    lines.push('', 'provider_routing:', ...block)
    return { yaml: lines.join('\n'), diff }
  }
  if (change.kind === 'provider_sort') {
    const line = '  sort: ' + change.value
    const i = lines.findIndex(l => /^provider_routing:\s*$/.test(l))
    if (i >= 0) {
      for (let j = i + 1; j < lines.length; j++) {
        if (/^[A-Za-z_]/.test(lines[j])) break
        if (/^\s+sort:/.test(lines[j])) {
          diff.push({ from: lines[j], to: line })
          lines[j] = line
          return { yaml: lines.join('\n'), diff }
        }
      }
      diff.push({ from: null, to: line })
      lines.splice(i + 1, 0, line)
      return { yaml: lines.join('\n'), diff }
    }
    diff.push({ from: null, to: 'provider_routing:\n' + line })
    lines.push('', 'provider_routing:', line)
    return { yaml: lines.join('\n'), diff }
  }
  if (change.kind === 'provider_routing') {
    const v = change.value || {}
    const block = []
    const pushList = (key, arr) => {
      if (!arr || !arr.length) return
      block.push('  ' + key + ':')
      for (const x of arr) block.push('    - ' + x)
    }
    const numOk = x => x !== '' && x != null && isFinite(parseFloat(x)) && parseFloat(x) >= 0
    const pushMap = (key, obj) => {
      const entries = Object.entries(obj).filter(([, x]) => numOk(x))
      if (!entries.length) return
      block.push('  ' + key + ':')
      for (const [k, x] of entries) block.push('    ' + k + ': ' + parseFloat(x))
    }
    const pushPerf = (key, p50, rest) => {
      const others = Object.entries(rest || {}).filter(([, x]) => numOk(x))
      if (!others.length) {
        if (numOk(p50) && parseFloat(p50) > 0) block.push('  ' + key + ': ' + parseFloat(p50))
        return
      }
      pushMap(key, numOk(p50) ? { p50, ...rest } : rest)
    }
    if (v.sort) block.push('  sort: ' + v.sort)
    pushList('only', v.only)
    pushList('ignore', v.ignore)
    pushList('order', v.order)
    if (v.requireParams) block.push('  require_parameters: true')
    if (v.dataDeny) block.push('  data_collection: deny')
    // keys Hermes does not forward itself; the hermetic backend middleware sends them
    if (v.allowFallbacks === false) block.push('  allow_fallbacks: false')
    if (v.zdr) block.push('  zdr: true')
    if (v.distill) block.push('  enforce_distillable_text: true')
    pushList('quantizations', v.quants)
    pushMap('max_price', { prompt: v.maxIn, completion: v.maxOut, ...(v.maxRest || {}) })
    pushPerf('preferred_min_throughput', v.minTps, v.tpsRest)
    pushPerf('preferred_max_latency', v.maxLat, v.latRest)
    const MANAGED = new Set(['sort', 'only', 'ignore', 'order', 'require_parameters', 'data_collection', 'allow_fallbacks', 'zdr', 'enforce_distillable_text', 'quantizations', 'max_price', 'preferred_min_throughput', 'preferred_max_latency'])
    const i = lines.findIndex(l => /^provider_routing:\s*$/.test(l))
    if (i >= 0) {
      let j = i + 1
      for (; j < lines.length; j++) if (/^[A-Za-z_]/.test(lines[j])) break
      const old = lines.slice(i + 1, j)
      // keep every key this editor does not manage (models overrides, anything newer) verbatim
      for (let k = 0; k < old.length; k++) {
        const m = old[k].match(/^\s{2}([A-Za-z0-9_]+):/)
        if (!m || MANAGED.has(m[1])) continue
        let e = k + 1
        while (e < old.length && (/^\s{4}/.test(old[e]) || /^\s*#/.test(old[e]))) e++
        block.push(...old.slice(k, e))
        k = e - 1
      }
      const oldText = old.filter(l => !/^\s*$/.test(l)).join('\n')
      const newText = block.join('\n')
      if (oldText === newText) return { yaml: lines.join('\n'), diff }
      diff.push({ from: 'provider_routing:\n' + oldText, to: block.length ? 'provider_routing:\n' + newText : '(provider_routing removed)' })
      if (block.length) lines.splice(i, j - i, 'provider_routing:', ...block, '')
      else lines.splice(i, j - i)
      return { yaml: lines.join('\n'), diff }
    }
    if (!block.length) return { yaml: lines.join('\n'), diff }
    diff.push({ from: null, to: ['provider_routing:'].concat(block).join('\n') })
    lines.push('', 'provider_routing:', ...block)
    return { yaml: lines.join('\n'), diff }
  }
  if (change.kind === 'aux') {
    const line = '  openrouter_model: "' + change.model + '"'
    const i = lines.findIndex(l => /^auxiliary:\s*$/.test(l))
    if (i >= 0) {
      for (let j = i + 1; j < lines.length; j++) {
        if (/^[A-Za-z_]/.test(lines[j])) break
        if (/^\s+openrouter_model:/.test(lines[j])) {
          diff.push({ from: lines[j], to: line })
          lines[j] = line
          return { yaml: lines.join('\n'), diff }
        }
      }
      diff.push({ from: null, to: line })
      lines.splice(i + 1, 0, line)
      return { yaml: lines.join('\n'), diff }
    }
    diff.push({ from: null, to: 'auxiliary:\n' + line })
    lines.push('', 'auxiliary:', line)
    return { yaml: lines.join('\n'), diff }
  }
  return null
}

const Improve = ({ items, yaml, profile, onApplied }) => {
  const [open, setOpen] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const max = Math.max.apply(null, items.map(i => i.save).concat([0.0001]))

  const apply = async item => {
    if (!item.change) return
    setBusy(true)
    setErr(null)
    try {
      const latest = await freshConfig(profile)
      const change = buildYamlChange(latest, typeof item.change === 'function' ? item.change(latest) : item.change)
      if (!change) return
      await api(profileReq(profile, { path: '/api/config/raw', method: 'PUT', body: { yaml_text: change.yaml } }))
      if (item.after) await item.after()
      setOpen(null)
      onApplied()
    } catch (e) {
      setErr((e && e.message) || 'write failed')
    } finally {
      setBusy(false)
    }
  }

  const totalSave = items.reduce((a, i) => a + i.save, 0)
  return el(
    Section,
    { id: 'improve', title: el('span', null, 'Improve', el('span', { style: { color: C.dim, marginLeft: 8 } }, items.length + (items.length === 1 ? ' fix' : ' fixes'))), right: fmtUsd(totalSave, { approx: items.some(i => i.approx) }) },
    items.map(item => {
      const preview = open === item.id && item.change ? buildYamlChange(yaml, typeof item.change === 'function' ? item.change(yaml) : item.change) : null
      return el(
        'div',
        { key: item.id, style: { borderTop: '1px solid ' + C.stroke, padding: '8px 0' } },
        el(
          'div',
          { style: { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 56px 64px', gap: 10, alignItems: 'center' } },
          el(
            'div',
            { style: { minWidth: 0 } },
            el('div', { style: { fontSize: 12, color: C.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, item.label),
            el('div', { style: { marginTop: 6 } }, el(Track, { value: item.save / max, height: 5 }))
          ),
          item.metric != null
            ? el(Tip, { label: item.tip || '' }, el('div', { style: { fontSize: 11, textAlign: 'right', color: C.warn, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', cursor: 'help' } }, item.metric))
            : el('div', { style: { fontSize: 12, textAlign: 'right', color: C.text, fontVariantNumeric: 'tabular-nums' } }, fmtUsd(item.save, { approx: item.approx })),
          el(
            'button',
            {
              type: 'button',
              onClick: () => setOpen(open === item.id ? null : item.id),
              className: 'rounded-[4px] px-2 py-1 text-[11px] text-(--ui-text-secondary) hover:bg-(--chrome-action-hover) hover:text-(--ui-text-primary)',
              style: { border: '1px solid ' + C.stroke, background: 'transparent', cursor: 'pointer' }
            },
            open === item.id ? 'Cancel' : 'Apply'
          )
        ),
        preview
          ? el(
              'div',
              { style: { marginTop: 8, background: 'var(--ui-bg-tertiary)', borderRadius: 6, padding: '8px 10px', fontSize: 11 } },
              preview.diff.map((d, i) =>
                el(
                  'div',
                  { key: i, style: { fontFamily: 'var(--font-mono, ui-monospace, monospace)', whiteSpace: 'pre-wrap' } },
                  d.from != null ? el('div', { style: { color: C.bad } }, '- ' + d.from.trim()) : null,
                  el('div', { style: { color: C.ok } }, '+ ' + d.to.trim())
                )
              ),
              el(
                'div',
                { style: { display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' } },
                el(
                  'button',
                  {
                    type: 'button',
                    disabled: busy,
                    onClick: () => apply(item),
                    className: 'rounded-[4px] px-2.5 py-1 text-[11px] font-medium',
                    style: { background: C.accent, color: 'white', border: 'none', cursor: 'pointer', opacity: busy ? 0.6 : 1 }
                  },
                  busy ? 'Writing…' : 'Write to config.yaml'
                ),
                err ? el('span', { style: { color: C.bad } }, err) : null
              )
            )
          : null
      )
    })
  )
}

// ---- popover body -----------------------------------------------------------

const SessionRow = ({ s, threshold, hot, onHover, current }) => {
  if (s.synthetic)
    return el(
      'div',
      {
        style: { display: 'grid', gridTemplateColumns: 'minmax(0,1.5fr) 52px minmax(0,1fr) 30px 46px', gap: 8, alignItems: 'center', padding: '7px 0', borderTop: '1px solid ' + C.stroke, fontSize: 12 },
        title: 'Delegate runs and hidden sessions: total minus the sessions listed above'
      },
      el('div', { style: { display: 'flex', alignItems: 'center', gap: 6, color: C.sub } }, el('span', { style: { color: C.faint } }, '⌐'), el('span', null, s.title)),
      el('div', { style: { textAlign: 'right', color: C.text, fontVariantNumeric: 'tabular-nums' } }, fmtUsd(s.cost).replace(/^\$/, '')),
      el('div', null),
      el('div', null),
      el('div', null)
    )
  const tone = s.ctxShare != null && s.ctxShare >= threshold ? 'warn' : null
  const rateTone = s.ratePerHour >= 5 ? 'bad' : s.ratePerHour >= 1.5 ? 'warn' : null
  return el(
    'div',
    {
      onMouseEnter: () => onHover && onHover(s.id),
      onMouseLeave: () => onHover && onHover(null),
      style: {
        display: 'grid',
        gridTemplateColumns: 'minmax(0,1.5fr) 52px minmax(0,1fr) 30px 46px',
        gap: 8,
        alignItems: 'center',
        padding: '7px 6px',
        margin: '0 -6px',
        borderRadius: 4,
        borderTop: '1px solid ' + C.stroke,
        background: hot || current ? 'var(--ui-row-hover-background, var(--ui-bg-tertiary))' : 'transparent',
        fontSize: 12
      },
      title: trunc(s.title, 80) + ', ' + s.calls + ' calls, ' + fmtTok(s.ctxPerCall) + ' tokens per call' + (s.hit != null ? ', cache ' + fmtPct(s.hit) : '')
    },
    el(
      'div',
      { style: { minWidth: 0, display: 'flex', alignItems: 'center', gap: 6, color: C.text } },
      s.kind === 'subagent' ? el('span', { style: { color: C.faint, flex: 'none' } }, '⌐') : null,
      el('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, s.title.replace(/^Subagent:\s*/i, '')),
      current
        ? el('span', { style: { flex: 'none', fontSize: 10, padding: '1px 6px', borderRadius: 9, border: '1px solid ' + C.stroke, color: C.sub } }, 'current')
        : null
    ),
    el('div', { style: { textAlign: 'right', color: C.text, fontVariantNumeric: 'tabular-nums' } }, fmtUsd(s.cost).replace(/^\$/, '')),
    s.ctxShare != null ? el(Track, { value: s.ctxShare, tick: threshold, tone }) : el('div', { style: { height: 4 } }),
    el('div', { style: { textAlign: 'right', color: (s.swaps || 0) >= 3 ? C.warn : s.resets ? C.sub : C.faint, fontVariantNumeric: 'tabular-nums' }, title: s.resets ? s.resets + ' cache resets, ' + fmtUsd(s.toll || 0) + ' toll' : 'no cache resets recorded' }, s.resets ? String(s.resets) : '–'),
    el('div', { style: { textAlign: 'right', color: rateTone === 'bad' ? C.bad : rateTone === 'warn' ? C.warn : C.sub, fontVariantNumeric: 'tabular-nums' } }, fmtRate(s.ratePerHour).replace(/^\$/, '').replace('/h', ''))
  )
}

// ---- AAI: what changed the agent's setup, and the work to improve it ------------------------------
// Phase 1 (no model calls): skill versions and loads, always-on skill cost, routing history, provider
// errors, turn ratings; jobs: archive unused skills, turn fallback on, rate turns.

const AAI_DAYS = { today: 1, '7d': 7, '30d': 30 }
const ABtn = ({ children, onClick, primary, disabled }) =>
  el(
    'button',
    {
      type: 'button',
      onClick,
      disabled,
      className: primary ? undefined : 'hover:bg-(--ui-bg-tertiary) hover:text-(--ui-text-primary)',
      style: { display: 'inline-flex', alignItems: 'center', height: 22, padding: '0 10px', borderRadius: 6, font: 'inherit', fontSize: 11, whiteSpace: 'nowrap', flex: 'none', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.6 : 1, border: primary ? 'none' : '1px solid ' + C.stroke, background: primary ? C.accent : 'transparent', color: primary ? '#fff' : C.sub }
    },
    children
  )
const ALink = ({ children, onClick }) =>
  el('button', { type: 'button', onClick, className: 'hover:underline', style: { background: 'none', border: 'none', padding: 0, font: 'inherit', fontSize: 11, color: C.accent, cursor: 'pointer' } }, children)
const ago = ts => {
  const s = Date.now() / 1000 - ts
  return s < 3600 ? Math.max(1, Math.round(s / 60)) + 'm ago' : s < 86400 ? Math.round(s / 3600) + 'h ago' : new Date(ts * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// ---- AAI phases 2 and 3: shared helpers ----
// Model calls (replay, drafts, judge) can take minutes; the desktop bridge gives up after 30 s and
// allows only a few requests at once. So they run as backend jobs and this polls until done.
const AAI_LONG = ['/replay', '/draft', '/judge', '/variants']
const aaiPost = async (profile, path, body) => {
  const req = b => api(profileReq(profile, { path: '/api/plugins/hermetic/aai' + path, method: 'POST', body: b }))
  const long = AAI_LONG.includes(path) || (path === '/rubric' && body && body.draft)
  if (!long) return req(body || {})
  const started = await req(Object.assign({}, body || {}, { background: true }))
  if (!started || !started.job) return started
  for (let i = 0; i < 400; i++) {
    await new Promise(r => setTimeout(r, i < 5 ? 800 : 1500))
    const j = await api(profileReq(profile, { path: '/api/plugins/hermetic/aai/job?id=' + started.job }))
    if (j && j.done) return j.result || { ok: false, error: 'No result' }
  }
  return { ok: false, error: 'Still running after 10 minutes; check back later' }
}
const aaiGet = (profile, path) => api(profileReq(profile, { path: '/api/plugins/hermetic/aai' + path }))
const aSmall = t => el('span', { style: { fontSize: 10.5, color: C.dim } }, t)
const aTd = (v, color, left) => el('td', { style: { textAlign: left ? 'left' : 'right', color: color || C.sub, borderTop: '1px solid ' + C.stroke, padding: '4px 0', whiteSpace: 'nowrap', maxWidth: left ? 150 : undefined, overflow: 'hidden', textOverflow: 'ellipsis' } }, v)
const aTable = (cols, rows) =>
  el('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: 11, fontVariantNumeric: 'tabular-nums', marginTop: 6 } },
    el('tbody', null, el('tr', null, cols.map((h, i) => el('th', { key: h, style: { textAlign: i ? 'right' : 'left', fontWeight: 400, color: C.dim, fontSize: 10.5, paddingBottom: 4 } }, h))), rows))
// failure kinds as a short label: "2 no call, 1 wrong tool"
const aKinds = k => Object.entries(k || {}).filter(([, n]) => n).map(([name, n]) => n + ' ' + name).join(', ')
// a gap of one case on a handful of cases is noise, not a result
const aNoise = (a, b) => Math.abs(a.passed - b.passed) <= 1 && Math.min(a.n, b.n) < 5
const aSummary = summary =>
  aTable(['setup', 'passed', 'issues', 'errors', 'cost'], summary.map(s =>
    el('tr', { key: s.label },
      aTd(el(Tip, { label: (s.providers && s.providers.length ? 'Served by ' + s.providers.join(', ') : 'No provider recorded') + (s.judged ? ', judge checked ' + s.judged : '') }, el('span', null, s.label)), C.text, true),
      aTd(s.passed + '/' + s.n, s.passed === s.n ? C.ok : C.warn),
      aTd(aKinds(s.kinds) || (s.empty ? s.empty + ' empty' : '–'), aKinds(s.kinds) || s.empty ? C.warn : C.dim),
      aTd(s.errors, s.errors ? C.bad : C.dim),
      aTd('$' + s.cost.toFixed(3)))))

// Open the chat that holds a reply in a new tab (the supported host call; Hermes has no
// jump-to-message API, so the person scrolls to it).
async function aaiOpenAt(profile, sessionId) {
  try {
    await host.openSession(sessionId, { profile: profile && profile !== 'default' ? profile : undefined, awaitHydration: true, intent: 'tab' })
    return true
  } catch {
    return false
  }
}
const AaiOpenLink = ({ profile, sessionId, userTs, label }) =>
  sessionId ? el(ALink, { onClick: () => aaiOpenAt(profile, sessionId) }, label || 'open in chat') : null

// One case opened: its reproduction record and drafted variations
const AaiCaseRecord = ({ profile, id, onChanged }) => {
  const [rec, setRec] = useState(null)
  const [vars, setVars] = useState(null)
  const [varErr, setVarErr] = useState(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { aaiGet(profile, '/case?id=' + encodeURIComponent(id)).then(setRec).catch(() => setRec({ ok: false })) }, [id])
  if (!rec) return aSmall('Loading…')
  if (!rec.ok) return aSmall('Could not load this case')
  const line = (k, v) => el('div', { key: k, style: { display: 'flex', gap: 8, fontSize: 10.5, lineHeight: 1.5 } }, el('span', { style: { color: C.dim, minWidth: 64 } }, k), el('span', { style: { color: C.sub, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } }, v))
  const routing = rec.routing ? Object.entries(rec.routing).map(([k, v]) => k + ' ' + (Array.isArray(v) ? v.join('/') : String(v))).join(', ') : '–'
  const more = async () => {
    setBusy(true)
    try {
      const r = await aaiPost(profile, '/variants', { case_id: id, n: 3 })
      setVars(r.ok ? r.variants : [])
      setVarErr(r.ok ? null : r.error || 'Could not draft variations')
    } finally {
      setBusy(false)
    }
  }
  const keep = async text => { await aaiPost(profile, '/cases', { base_case: id, user_override: text }); setVars(v => v.filter(x => x !== text)); onChanged() }
  return el(
    'div',
    { style: { background: 'var(--ui-bg-tertiary)', borderRadius: 6, padding: '7px 9px', margin: '4px 0 6px' } },
    el('div', { style: { marginBottom: 4 } }, el(AaiOpenLink, { profile, sessionId: rec.session_id, userTs: rec.user_ts, label: 'open the chat' })),
    line('replays', rec.case && rec.case.mode === 'reply' ? 'the reply you corrected, with the same tool results' : 'the first step after the request'),
    line('request', rec.request),
    line('reply', rec.reply),
    line('model', rec.model || '–'),
    line('session', (rec.session || '–') + ', ' + rec.messages + ' messages'),
    line('skills', rec.skills.join(', ') || '–'),
    line('routing', routing),
    line('runs', rec.runs.length ? rec.runs.map(r => (r.label || 'run') + ' ' + (r.ok ? (r.passed ? 'pass' : 'fail') : 'error')).join(', ') : 'none yet'),
    el('div', { style: { display: 'flex', gap: 10, alignItems: 'center', marginTop: 6 } },
      el(ABtn, { onClick: more, disabled: busy }, busy ? 'Drafting…' : 'More like this'),
      aSmall('drafts 3 variations of the request')),
    vars && vars.length
      ? vars.map((v, i) => el('div', { key: i, style: { display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 11, color: C.sub, padding: '4px 0', borderTop: '1px solid ' + C.stroke } },
          el('span', { style: { flex: 1 } }, v), el(ALink, { onClick: () => keep(v) }, 'keep'), el(ALink, { onClick: () => setVars(x => x.filter(y => y !== v)) }, 'drop')))
      : varErr ? el('div', { style: { fontSize: 10.5, color: C.warn, marginTop: 6 } }, varErr) : vars ? aSmall('No variations drafted') : null
  )
}

// Bake-off: the same cases on other providers or another model, cost beside the result
const AAI_SLUG = { OpenInference: 'open-inference', Relace: 'relace', Parasail: 'parasail', DigitalOcean: 'digitalocean', Together: 'together', Wafer: 'wafer', Morph: 'morph', 'Sail Research': 'sail-research', AtlasCloud: 'atlas-cloud', Fireworks: 'fireworks', Mistral: 'mistral', InferenceNet: 'inference-net', DeepInfra: 'deepinfra', BaseTen: 'baseten' }
const aaiSlug = n => AAI_SLUG[n] || String(n).toLowerCase().replace(/[^a-z0-9]+/g, '-')

// Gate: every skill change the background review makes is tested on that skill's cases
const AAI_GATE_MODES = [
  { v: 'off', label: 'off', tip: 'No automatic tests' },
  { v: 'ask', label: 'test, ask me', tip: 'Test each change; if it does worse, show it here to revert' },
  { v: 'revert', label: 'test, revert', tip: 'Test each change; if it does worse, put the earlier version back' }
]

const AaiGate = ({ profile }) => {
  const [g, setG] = useState(null)
  const [settings, setSettings] = useState(null)
  const load = () => {
    aaiGet(profile, '/gate').then(setG).catch(() => setG({ decisions: [] }))
    aaiGet(profile, '/settings').then(setSettings).catch(() => {})
  }
  useEffect(() => { load() }, [profile])
  if (!g || !settings) return aSmall('Loading…')
  const setMode = async v => { setSettings(await aaiPost(profile, '/settings', { gate_mode: v })) }
  const revert = async d => { await aaiPost(profile, '/revert', { skill: d.skill, sha: d.before_sha }); load() }
  const decisions = (g.decisions || []).slice().reverse()
  return el(
    'div',
    null,
    el('div', { style: { display: 'flex', gap: 4, alignItems: 'center', marginTop: 4, flexWrap: 'wrap' } },
      aSmall('When the review changes a skill'),
      AAI_GATE_MODES.map(m => el(Tip, { key: m.v, label: m.tip },
        el('button', { type: 'button', onClick: () => setMode(m.v), style: { font: 'inherit', fontSize: 10.5, padding: '1px 7px', borderRadius: 5, cursor: 'pointer', border: '1px solid ' + C.stroke, background: settings.gate_mode === m.v ? 'var(--ui-bg-tertiary)' : 'transparent', color: settings.gate_mode === m.v ? C.text : C.sub } }, m.label)))),
    el('div', { style: { marginTop: 6 } }, aSmall('Spent today $' + Number(settings.spent_today || 0).toFixed(3) + ' of $' + Number(settings.daily_budget).toFixed(2) + ' for automatic tests. Checks every 5 minutes.')),
    decisions.length
      ? aTable(['skill', 'before', 'after', 'result'], decisions.slice(0, 8).map((d, i) =>
          el('tr', { key: i },
            aTd(d.skill, C.text, true),
            aTd(d.before != null ? d.before + '/' + d.cases : '–'),
            aTd(d.after != null ? d.after + '/' + d.cases : '–', d.verdict === 'worse' ? C.bad : undefined),
            aTd(d.action === 'asked' ? el(ALink, { onClick: () => revert(d) }, 'revert') : d.action === 'reverted' ? 'reverted' : d.verdict, d.verdict === 'worse' ? C.bad : C.dim))))
      : el('div', { style: { marginTop: 6 } }, aSmall(settings.gate_mode === 'off' ? 'Off. Turn it on to test changes from now on.' : 'No changes tested yet.'))
  )
}

// Fix a skill: draft a candidate with Hermes, test it against the current version, ship or drop
const AaiFix = ({ profile, skill, onDone, onStep }) => {
  const [step, setStep] = useState('start')
  useEffect(() => { if (onStep) onStep(step) }, [step])
  const [draft, setDraft] = useState(null)
  const [test, setTest] = useState(null)
  const [error, setError] = useState(null)
  const go = async (name, fn) => {
    setError(null)
    setStep(name + '…')
    try {
      await fn()
    } catch (e) {
      setError((e && e.message) || 'failed')
      setStep('start')
    }
  }
  const doDraft = () => go('draft', async () => {
    const r = await aaiPost(profile, '/draft', { skill })
    if (!r.ok) throw new Error(r.error)
    setDraft(r)
    setStep('drafted')
  })
  const doTest = () => go('test', async () => {
    const r = await aaiPost(profile, '/replay', { skill, variants: [{ label: 'current', skill_name: skill, version: 'current' }, { label: 'candidate', skill_name: skill, version: draft.candidate }] })
    if (!r.ok) throw new Error(r.error)
    setTest(r)
    setStep('tested')
  })
  const doShip = () => go('ship', async () => {
    const r = await aaiPost(profile, '/ship', { skill, candidate: draft.candidate })
    if (!r.ok) throw new Error(r.error)
    setStep('shipped')
    if (onDone) onDone()
  })
  const s = test ? Object.fromEntries(test.summary.map(x => [x.label, x])) : null
  const better = s && s.candidate.passed >= s.current.passed
  return el(
    'div',
    { style: { width: '100%' } },
    step === 'start' ? el('div', { style: { display: 'flex', gap: 10, alignItems: 'center' } }, el(ABtn, { onClick: doDraft }, 'Draft a fix'), aSmall('Hermes writes a candidate; nothing goes live')) : null,
    step.endsWith('…') ? aSmall(step === 'draft…' ? 'Hermes is drafting…' : step === 'test…' ? 'Replaying the cases on both versions…' : 'Shipping…') : null,
    draft && step !== 'start'
      ? el('div', { style: { marginTop: 6 } },
          draft.diff.length
            ? el('pre', { style: { fontSize: 10, lineHeight: '15px', background: 'var(--ui-bg-secondary, rgba(0,0,0,.2))', borderRadius: 6, padding: '6px 8px', maxHeight: 160, overflow: 'auto', whiteSpace: 'pre-wrap', margin: 0 } },
                draft.diff.map((l, i) => el('div', { key: i, style: { color: l.startsWith('+') ? C.ok : l.startsWith('-') ? C.bad : C.dim } }, l)))
            : aSmall('No changes proposed. The cases may need clearer notes.'),
          aSmall('Draft cost $' + Number(draft.cost || 0).toFixed(3) + ', by ' + draft.model))
      : null,
    step === 'drafted' && draft.diff.length ? el('div', { style: { display: 'flex', gap: 10, marginTop: 8 } }, el(ABtn, { primary: true, onClick: doTest }, 'Test it'), el(ALink, { onClick: () => { setDraft(null); setStep('start') } }, 'drop')) : null,
    test && (step === 'tested' || step === 'shipped') ? aSummary(test.summary) : null,
    step === 'tested'
      ? el('div', { style: { display: 'flex', gap: 10, alignItems: 'center', marginTop: 8 } },
          el(ABtn, { primary: better, onClick: doShip }, 'Ship candidate'),
          el(ALink, { onClick: () => { setDraft(null); setTest(null); setStep('start') } }, 'keep current'),
          aSmall(aNoise(s.candidate, s.current) && s.candidate.passed !== s.current.passed ? 'too few cases to tell' : better ? 'passes at least as many cases' : 'passes fewer cases than current'))
      : null,
    step === 'shipped' ? el('div', { style: { fontSize: 11, color: C.ok, marginTop: 6 } }, 'Live. The earlier version is saved and can be restored.') : null,
    error ? el('div', { style: { fontSize: 10.5, color: C.bad, marginTop: 6 } }, error) : null
  )
}

// Compare any two saved versions of a skill on its cases
const AaiVersions = ({ profile, skills, noTests }) => {
  const [picked, setSkill] = useState('')
  const skill = picked || skills[0] || ''
  const [data, setData] = useState(null)
  const [pick, setPick] = useState([])
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState(null)
  useEffect(() => {
    if (!skill) return
    setData(null); setPick([]); setRes(null)
    aaiGet(profile, '/versions?skill=' + encodeURIComponent(skill)).then(setData).catch(() => setData({ versions: [] }))
  }, [skill])
  if (!skills.length) return aSmall('Save a case for a skill first; versions are compared on its cases.')
  const toggle = sha => setPick(p => (p.includes(sha) ? p.filter(x => x !== sha) : p.concat([sha]).slice(-2)))
  const run = async () => {
    setBusy(true)
    try {
      const vs = pick.map(sha => ({ label: (data.versions.find(v => v.sha === sha) || {}).current ? 'current' : sha.slice(0, 7), skill_name: skill, version: sha }))
      setRes(await aaiPost(profile, '/replay', { skill, variants: vs }))
    } finally {
      setBusy(false)
    }
  }
  const s = res && res.ok && res.summary.length === 2 ? res.summary : null
  return el(
    'div',
    null,
    skills.length > 1
      ? el('select', { value: skill, onChange: e => setSkill(e.target.value), style: { font: 'inherit', fontSize: 11, marginTop: 4, background: 'transparent', color: C.text, border: '1px solid ' + C.stroke, borderRadius: 5, padding: '2px 6px' } },
          skills.map(n => el('option', { key: n, value: n }, n)))
      : null,
    !data ? aSmall(' Loading…')
      : !data.versions.length ? el('div', null, aSmall('No saved versions yet. They are kept from now on.'))
      : aTable(['version', 'saved', 'by', ''], data.versions.slice().reverse().map(v =>
          el('tr', { key: v.sha },
            aTd(v.sha.slice(0, 7) + (v.current ? ' (current)' : ''), v.current ? C.text : C.sub, true),
            aTd(v.ts ? (typeof v.ts === 'number' ? ago(v.ts) : String(v.ts).slice(5, 16).replace('T', ' ')) : '–', C.dim),
            aTd(v.actor === 'agent' ? 'chat' : v.actor === 'curator' ? 'review' : v.actor || 'Hermetic', C.dim),
            aTd(el('input', { type: 'checkbox', checked: pick.includes(v.sha), onChange: () => toggle(v.sha) }))))),
    data && data.versions.length > 1 && noTests
      ? el('div', { style: { marginTop: 6 } }, aSmall('Keep a test for this skill to compare versions on it.'))
      : data && data.versions.length > 1
      ? el('div', { style: { display: 'flex', gap: 10, alignItems: 'center', marginTop: 8 } },
          el(ABtn, { onClick: run, disabled: busy || pick.length !== 2 }, busy ? 'Replaying…' : 'Compare'),
          aSmall(pick.length === 2 ? 'replays the cases on both' : 'tick two versions'))
      : null,
    res && res.ok ? aSummary(res.summary) : res && res.error ? el('div', { style: { fontSize: 10.5, color: C.bad, marginTop: 6 } }, res.error) : null,
    s ? aSmall(aNoise(s[0], s[1]) ? 'Too few cases to tell these apart.' : s[0].providers.join() !== s[1].providers.join() ? 'Different providers served each version, so part of the gap may be the provider.' : 'Same provider for both.') : null
  )
}

// Settings: automatic tests of skill changes, and the judge as one switch (its rubric is written from each skill)
const AaiSettings = ({ profile, ratings }) => {
  const [st, setSt] = useState(null)
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState(null)
  useEffect(() => { aaiGet(profile, '/settings').then(setSt).catch(() => setSt({})) }, [profile])
  if (!st) return aSmall('Loading…')
  const on = st.judge_checks === 'on'
  const ready = ratings.total >= 20 && ratings.low >= 5
  const check = async () => { setBusy(true); try { setRes(await aaiPost(profile, '/judge')) } finally { setBusy(false) } }
  return el('div', null,
    el(AaiGate, { profile }),
    el('div', { style: { borderTop: '1px solid ' + C.stroke, marginTop: 12, paddingTop: 10 } },
      el('label', { style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 11.5, color: C.text, cursor: 'pointer' } },
        el('input', { type: 'checkbox', checked: on, onChange: async () => setSt(await aaiPost(profile, '/settings', { judge_checks: on ? 'off' : 'on' })) }),
        'Grade replays with a judge model', el(InfoDot, { tip: 'Another model reads each replayed reply and says pass or fail. The first time a skill is graded, its rubric is written from the skill itself. About $0.0001 per test.' })),
      ready
        ? el('div', { style: { display: 'flex', gap: 10, alignItems: 'center', marginTop: 8 } },
            el(BigBtn, { ghost: true, onClick: check, disabled: busy }, busy ? 'Checking…' : 'Check the judge against your stars'),
            res && res.n != null ? el('span', { style: { fontSize: 11, color: res.trusted ? C.ok : C.warn } }, 'agrees on ' + res.agree + ' of ' + res.n + (res.trusted ? ', trusted' : ', not trusted yet')) : null)
        : null))
}

// ---- AAI v7 layout: "your turn" cards (input), "what's happening" (read only), tools, settings ----
const V7 = { accent: 'var(--ui-accent)', card: 'var(--ui-bg-tertiary)' }
const InfoDot = ({ tip }) =>
  el(Tip, { label: tip }, el('span', { style: { display: 'inline-flex', width: 15, height: 15, borderRadius: 8, border: '1px solid ' + C.faint, color: C.dim, fontSize: 9.5, alignItems: 'center', justifyContent: 'center', cursor: 'help', flex: 'none' } }, 'i'))
const TaskCard = ({ id, title, tip, count, done, children }) =>
  el('div', { id, style: { background: V7.card, borderRadius: 10, borderLeft: '3px solid ' + (done ? C.ok : V7.accent), padding: '11px 12px', marginTop: 10, opacity: done ? 0.6 : 1 } },
    el('div', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, fontWeight: 500, color: C.text } }, title, tip ? el(InfoDot, { tip }) : null,
      count ? el('span', { style: { marginLeft: 'auto', fontSize: 11, fontWeight: 400, color: C.sub } }, count) : null),
    children)
const BigBtn = ({ children, onClick, ghost, disabled }) =>
  el('button', { type: 'button', onClick, disabled, style: { border: ghost ? '1px solid ' + C.stroke : 'none', borderRadius: 8, padding: '7px 14px', font: 'inherit', fontSize: 12, cursor: disabled ? 'default' : 'pointer', background: ghost ? 'transparent' : V7.accent, color: ghost ? C.sub : '#fff', fontWeight: ghost ? 400 : 500, opacity: disabled ? 0.45 : 1, whiteSpace: 'nowrap' } }, children)
const Row = (...kids) => el('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' } }, ...kids)
const PickChip = ({ on, onClick, children }) =>
  el('span', { onClick, style: { fontSize: 11, color: on ? C.text : C.sub, border: '1px solid ' + (on ? V7.accent : C.stroke), background: on ? 'rgba(107,132,230,.15)' : 'transparent', borderRadius: 14, padding: '4px 10px', cursor: 'pointer', userSelect: 'none' } }, children)
const STAR_WORDS = ['', 'bad', 'poor', 'okay', 'good', 'great']
const REASONS = ['wrong facts', 'missed the point', 'too long', 'wrong tool', 'unsafe']

// one reply to rate: stars light up under the pointer; 3 or fewer asks why and can keep it as a test
const RateItem = ({ profile, item, onDone }) => {
  const [hot, setHot] = useState(0)
  const [score, setScore] = useState(0)
  const [reasons, setReasons] = useState([])
  const [note, setNote] = useState('')
  const [keep, setKeep] = useState(true)
  const [busy, setBusy] = useState(false)
  const submit = async n => {
    setBusy(true)
    try {
      await aaiPost(profile, '/rate', { message_id: item.message_id, session_id: item.session_id, score: n, reasons, note })
      if (n <= 3 && keep) await aaiPost(profile, '/cases', { message_id: item.message_id, mode: 'reply', note: [reasons.join(', '), note].filter(Boolean).join('. '), title: [reasons.join(', '), note].filter(Boolean).join('. ') || undefined })
      onDone(n)
    } finally {
      setBusy(false)
    }
  }
  const pick = n => { setScore(n); if (n >= 4) submit(n) }
  const shown = hot || score
  return el('div', { style: { paddingTop: 8 } },
    el('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
      el('span', { style: { flex: 1, minWidth: 0, fontSize: 12, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.title),
      el(AaiOpenLink, { profile, sessionId: item.session_id, userTs: item.user_ts })),
    el('div', { style: { fontSize: 11, color: C.sub, marginTop: 3, lineHeight: 1.45, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' } }, item.preview),
    el('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 } },
      el('span', { onMouseLeave: () => setHot(0), style: { display: 'inline-flex', gap: 2 } },
        [1, 2, 3, 4, 5].map(n => el('span', { key: n, onMouseEnter: () => setHot(n), onClick: () => !busy && pick(n), style: { fontSize: 20, lineHeight: '20px', cursor: 'pointer', color: n <= shown ? C.warn : C.faint, transform: hot === n ? 'scale(1.12)' : 'none', transition: 'color 80ms, transform 80ms' } }, '★'))),
      el('span', { style: { fontSize: 11, color: C.dim } }, STAR_WORDS[shown] || '')),
    score && score <= 3
      ? el('div', { style: { marginTop: 8 } },
          el('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } }, REASONS.map(r => el(PickChip, { key: r, on: reasons.includes(r), onClick: () => setReasons(x => (x.includes(r) ? x.filter(y => y !== r) : x.concat([r]))) }, r))),
          el('input', { value: note, onChange: e => setNote(e.target.value), placeholder: 'Anything else? (optional)', style: { width: '100%', marginTop: 7, boxSizing: 'border-box', background: 'transparent', border: '1px solid ' + C.stroke, borderRadius: 7, color: C.text, font: 'inherit', fontSize: 11.5, padding: '6px 8px' } }),
          Row(el('label', { style: { fontSize: 11, color: C.sub, display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' } }, el('input', { type: 'checkbox', checked: keep, onChange: () => setKeep(!keep) }), 'keep as a test'),
            el('span', { style: { flex: 1 } }), el(BigBtn, { onClick: () => submit(score), disabled: busy }, busy ? 'Saving…' : 'Done')))
      : null)
}

const RateTask = ({ profile, ratings, onChanged }) => {
  const [queue, setQueue] = useState(null)
  const [n, setN] = useState({ total: ratings.total || 0, low: ratings.low || 0 })
  useEffect(() => { aaiGet(profile, '/rate-queue?n=5').then(r => setQueue((r && r.items) || [])).catch(() => setQueue([])) }, [profile])
  if (queue == null) return el(TaskCard, { id: 'aai-t-rate', title: 'Rate recent replies' }, aSmall('Loading…'))
  const done = s => { setN(x => ({ total: x.total + 1, low: x.low + (s <= 2 ? 1 : 0) })); setQueue(q => q.slice(1)); if (onChanged) onChanged() }
  const good = Math.min(100, ((n.total - n.low) / 20) * 100), low = Math.min(100, (n.low / 20) * 100)
  return el(TaskCard, { id: 'aai-t-rate', title: 'Rate recent replies', tip: 'Your stars teach the judge what good looks like. After 20 ratings, 5 of them low, it can be checked against you.', count: queue.length ? queue.length + ' left' : 'all rated', done: !queue.length },
    queue.slice(0, 1).map(it => el(RateItem, { key: it.message_id, profile, item: it, onDone: done })),
    el('div', { style: { height: 8, background: 'var(--ui-bg-secondary, rgba(0,0,0,.25))', borderRadius: 4, overflow: 'hidden', display: 'flex', marginTop: 8 } },
      el('i', { style: { display: 'block', width: good + '%', background: C.ok } }), el('i', { style: { display: 'block', width: low + '%', background: C.bad } })),
    el('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: 10.5, color: C.dim, marginTop: 4 } }, el('span', null, n.total + ' of 20 ratings, ' + n.low + ' of 5 low'), el('span', null, 'judge trusted at 20')))
}

// corrections inbox: each one is kept as a test or dismissed, then leaves the list
const InboxTask = ({ profile, items, onChanged }) => {
  const [gone, setGone] = useState(() => new Set())
  const [busy, setBusy] = useState(null)
  const left = items.filter(it => !gone.has(it.correction_id))
  const act = async (it, keep) => {
    setBusy(it.correction_id)
    try {
      if (keep) await aaiPost(profile, '/cases', { message_id: it.message_id, note: it.text, title: it.text, mode: 'reply', skill: it.skill || undefined })
      else await aaiPost(profile, '/corrections/dismiss', { correction_id: it.correction_id })
      setGone(prev => new Set(prev).add(it.correction_id))
      if (keep && onChanged) onChanged()
    } finally {
      setBusy(null)
    }
  }
  return el(TaskCard, { id: 'aai-t-inbox', title: 'Times you corrected Hermes', tip: 'Found by wording such as “no”, “you forgot”, “again”. Keeping one makes it a test: the reply is asked again and checked against what you said.', count: left.length ? left.length + ' new' : 'none left', done: !left.length },
    left.slice(0, 4).map((it, i) =>
      el('div', { key: it.correction_id, style: { padding: '9px 0', borderTop: i ? '1px solid ' + C.stroke : 'none' } },
        el('div', { style: { fontSize: 12, color: C.text, lineHeight: 1.45 } }, '“' + it.text + '”'),
        el('div', { style: { display: 'flex', gap: 10, alignItems: 'center', marginTop: 4, fontSize: 11, color: C.dim } }, it.skill || 'no skill loaded', el('span', null, ago(it.ts)), el(AaiOpenLink, { profile, sessionId: it.session_id, userTs: it.user_ts })),
        Row(el(BigBtn, { onClick: () => act(it, true), disabled: busy === it.correction_id }, 'Keep as test'), el(BigBtn, { ghost: true, onClick: () => act(it, false), disabled: busy === it.correction_id }, 'Dismiss')))))
}

// unused skills as pills: click one to keep it, the rest are archived together
const ArchiveTask = ({ profile, unused, onDone }) => {
  const [keep, setKeep] = useState(() => new Set())
  const [busy, setBusy] = useState(false)
  const go = unused.filter(s => !keep.has(s.name))
  const tokens = go.reduce((a, s) => a + s.desc_tokens, 0)
  const run = async () => {
    setBusy(true)
    try {
      await api(profileReq(profile, { path: '/api/plugins/hermetic/aai/archive', method: 'POST', body: { skills: go.map(s => s.name) } }))
      onDone()
    } finally {
      setBusy(false)
    }
  }
  return el(TaskCard, { id: 'aai-t-archive', title: 'Archive skills you never use', tip: 'Enabled, not loaded once in 30 days, not new. Every enabled skill description is sent with every call. Undo any time.', count: go.length + ' of ' + unused.length },
    el('div', { style: { fontSize: 11, color: C.dim, marginTop: 6 } }, 'Click a skill to keep it'),
    el('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 } }, unused.map(s =>
      el(Tip, { key: s.name, label: s.desc_tokens + ' tokens per call' }, el('span', { onClick: () => setKeep(prev => { const n = new Set(prev); n.has(s.name) ? n.delete(s.name) : n.add(s.name); return n }), style: { fontSize: 11, padding: '4px 10px', borderRadius: 14, cursor: 'pointer', userSelect: 'none', border: '1px solid ' + C.stroke, color: keep.has(s.name) ? C.dim : C.text, textDecoration: keep.has(s.name) ? 'line-through' : 'none', background: keep.has(s.name) ? 'transparent' : 'rgba(255,255,255,.04)' } }, s.name)))),
    Row(el(BigBtn, { onClick: run, disabled: busy || !go.length }, busy ? 'Archiving…' : 'Archive ' + go.length), el('span', { style: { fontSize: 11, color: C.dim } }, 'saves about ' + fmtTok(tokens) + ' tokens per call')))
}

// a failing skill: draft, test, ship, shown as steps
const FIX_AT = { start: 0, 'draft…': 0, drafted: 1, 'test…': 1, tested: 2, 'ship…': 2, shipped: 3 }
const FixTask = ({ profile, skill, failing, onDone }) => {
  const [step, setStep] = useState('start')
  const at = FIX_AT[step] != null ? FIX_AT[step] : 0
  return el(TaskCard, { id: 'aai-t-fix-' + skill, title: 'Fix ' + skill, tip: 'Hermes drafts a new version, it is tested on the same tests, and you decide. About $0.03.', count: failing + (failing === 1 ? ' test fails' : ' tests fail'), done: at === 3 },
    el('div', { style: { display: 'flex', gap: 6, margin: '8px 0', fontSize: 11 } }, ['Draft', 'Test', 'Ship'].map((s, i) =>
      el('span', { key: s, style: { flex: 1, textAlign: 'center', padding: '4px 0', borderRadius: 6, border: '1px solid ' + (i === at ? V7.accent : C.stroke), background: i === at ? 'rgba(107,132,230,.15)' : 'transparent', color: i < at ? C.ok : i === at ? C.text : C.dim } }, (i < at ? '✓ ' : i + 1 + '  ') + s))),
    el(AaiFix, { profile, skill, onDone, onStep: setStep }))
}

// changes the gate held back for you
const GateTask = ({ profile, asked, onDone }) => {
  const revert = async d => { await aaiPost(profile, '/revert', { skill: d.skill, sha: d.before_sha }); onDone() }
  return el(TaskCard, { id: 'aai-t-gate', title: 'Skill changes that tested worse', tip: 'The background review changed these skills and the new version passed fewer tests.', count: asked.length + ' to decide' },
    asked.slice(0, 4).map((d, i) =>
      el('div', { key: i, style: { display: 'flex', gap: 10, alignItems: 'center', padding: '8px 0', borderTop: '1px solid ' + C.stroke, fontSize: 12, color: C.text } },
        el('span', { style: { flex: 1 } }, d.skill),
        el('span', { style: { fontSize: 11, color: C.sub } }, d.before + ' → ', el('b', { style: { color: C.bad, fontWeight: 500 } }, d.after), ' of ' + d.cases),
        el(BigBtn, { onClick: () => revert(d) }, 'Revert'))))
}

const caseStatus = l => {
  if (!l) return ['not run yet', C.dim, 'idle']
  if (!l.ok) return ['could not run', C.bad, 'bad']
  const ch = l.checks || {}
  if (ch.not_empty === false) return ['empty reply', C.bad, 'bad']
  if (ch.valid_tools === false) return ['broken tool call', C.bad, 'bad']
  if (ch.judge === false) return ['repeats the problem', C.bad, 'bad']
  if (ch.expected_tools === false || ch.no_tools === false || ch.never_tools === false) return ['wrong tools', C.warn, 'warn']
  return [ch.judge === true ? 'fixed' : 'no problem found', C.ok, 'ok']
}

// Same tests on your two most-used providers and a second model; results in words, one button to prefer the winner
const CompareProviders = ({ profile, providers, altModel, auxOn, onApplied }) => {
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState(null)
  const [done, setDone] = useState(null)
  const options = [{ label: 'as now', name: 'your current routing' }]
    .concat(providers.slice(0, 2).map(p => ({ label: 'only ' + p, provider: aaiSlug(p), name: p })))
    .concat(altModel ? [{ label: altModel.split('/').pop(), model: altModel, name: altModel.split('/').pop() }] : [])
  const nameOf = l => (options.find(o => o.label === l) || {}).name || l
  const run = async () => {
    setBusy(true)
    try {
      setRes(await aaiPost(profile, '/replay', { variants: options.map(o => ({ label: o.label, provider: o.provider, model: o.model })) }))
    } finally {
      setBusy(false)
    }
  }
  const prefer = async x => {
    const latest = await freshConfig(profile)
    const st = routingStateOf(configFacts(latest), auxOn)
    st.order = [x.provider]
    const change = buildYamlChange(latest, { kind: 'provider_routing', value: st })
    if (change && change.diff.length) await api(profileReq(profile, { path: '/api/config/raw', method: 'PUT', body: { yaml_text: change.yaml } }))
    if (auxOn) await api(profileReq(profile, { path: '/api/plugins/hermetic/aux-routing', method: 'POST', body: { enabled: true } }))
    await aaiPost(profile, '/work', { job: 'prefer', detail: x.provider })
    setDone(nameOf(x.label))
    if (onApplied) onApplied()
  }
  const sum = res && res.ok ? res.summary : null
  const now = sum && sum.find(x => x.label === 'as now')
  const best = sum && sum.filter(x => x.provider).sort((a, b) => b.passed - a.passed || a.cost - b.cost)[0]
  const wins = now && best && best.passed > now.passed && !aNoise(best, now)
  return el('div', { style: { marginTop: 10 } },
    el('div', { style: { display: 'flex', gap: 10, alignItems: 'center' } },
      el(BigBtn, { ghost: true, onClick: run, disabled: busy }, busy ? 'Comparing…' : 'Compare providers'),
      aSmall('asks again on ' + options.slice(1).map(o => o.name).join(', '))),
    sum
      ? el('div', { style: { marginTop: 8 } },
          sum.map(x => el('div', { key: x.label, style: { display: 'flex', gap: 8, fontSize: 11.5, padding: '3px 0', color: C.text } },
            el('span', { style: { flex: 1 } }, nameOf(x.label)),
            el('span', { style: { color: x.passed === x.n ? C.ok : x.passed ? C.warn : C.bad } }, 'passed ' + x.passed + ' of ' + x.n),
            el('span', { style: { color: C.dim, width: 56, textAlign: 'right', paddingRight: 6 } }, '$' + Number(x.cost || 0).toFixed(3)))),
          el('div', { style: { fontSize: 11, color: C.sub, marginTop: 6, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' } },
            done ? el('span', { style: { color: C.ok } }, done + ' is now tried first')
              : wins ? [el('span', { key: 't' }, nameOf(best.label) + ' did better.'), el(BigBtn, { key: 'b', onClick: () => prefer(best) }, 'Try ' + nameOf(best.label) + ' first')]
              : 'No clear winner. Keep your routing.'))
      : res && res.error ? el('div', { style: { fontSize: 10.5, color: C.bad, marginTop: 6 } }, res.error) : null)
}

// one tile per test, coloured by its last result; click for the full record, replay them all at once
const TestTiles = ({ profile, cases, onChanged, providers = [], altModel, auxOn, onApplied }) => {
  const [open, setOpen] = useState(null)
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState(null)
  if (!cases.length) return aSmall('No tests yet. Keep a correction or a low-rated reply as a test.')
  const replay = async () => {
    setBusy(true)
    try {
      setRes(await aaiPost(profile, '/replay', { variants: [{ label: 'as now' }] }))
      onChanged()
    } finally {
      setBusy(false)
    }
  }
  const sel = cases.find(c => c.id === open)
  const star = async c => { await aaiPost(profile, '/cases', { update_id: c.id, update: { critical: !c.critical } }); onChanged() }
  const drop = async c => { await aaiPost(profile, '/cases', { delete: c.id }); setOpen(null); onChanged() }
  return el('div', null,
    el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0,1fr))', gap: 6 } },
      cases.slice().reverse().map(c => {
        const [t, col] = caseStatus(c.last)
        return el('div', { key: c.id, onClick: () => setOpen(open === c.id ? null : c.id), style: { cursor: 'pointer', borderRadius: 8, padding: '7px 8px', background: open === c.id ? V7.card : 'rgba(255,255,255,.03)', borderTop: '2px solid ' + col } },
          el('div', { style: { fontSize: 11, color: C.text, lineHeight: 1.4, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' } }, (c.critical ? '★ ' : '') + (c.title || c.note || c.id)),
          el('div', { style: { fontSize: 10.5, color: col, marginTop: 3 } }, t))
      })),
    sel
      ? el('div', { style: { marginTop: 8 } },
          el('div', { style: { display: 'flex', gap: 14, alignItems: 'center', fontSize: 11 } },
            el(Tip, { label: 'A critical test that breaks makes a skill change count as worse' }, el(ALink, { onClick: () => star(sel) }, sel.critical ? '★ critical' : '☆ mark critical')),
            el(ALink, { onClick: () => drop(sel) }, 'remove test')),
          el(AaiCaseRecord, { profile, id: sel.id, onChanged }))
      : null,
    el('div', { style: { display: 'flex', gap: 10, alignItems: 'center', marginTop: 10 } },
      el(BigBtn, { ghost: true, onClick: replay, disabled: busy }, busy ? 'Replaying…' : 'Replay all'),
      aSmall('about $0.01 each, with your current routing')),
    res && res.ok ? aSummary(res.summary) : res && res.error ? el('div', { style: { fontSize: 10.5, color: C.bad, marginTop: 6 } }, res.error) : null,
    // too few tests and any gap is noise, so it only appears from 5 tests on
    cases.length >= 5 && providers.length ? el(CompareProviders, { profile, providers, altModel, auxOn, onApplied }) : null)
}

const TL_KINDS = [['skills', 'skills', C.ok], ['flagged', 'flagged', C.warn], ['routing', 'routing', C.sub], ['providers', 'providers', C.bad], ['Hermetic', 'Hermetic', 'var(--ui-accent)']]
const tlKind = t => (t.who === 'chat' || t.who === 'review' ? 'skills' : t.who === 'config' ? 'routing' : t.who)
const TimelineView = ({ items }) => {
  const [show, setShow] = useState(() => new Set(TL_KINDS.map(k => k[0])))
  const [more, setMore] = useState(false)
  const list = items.filter(t => show.has(tlKind(t)))
  return el('div', null,
    el('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 } }, TL_KINDS.map(([k, label]) => el(PickChip, { key: k, on: show.has(k), onClick: () => setShow(prev => { const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n }) }, label))),
    list.length
      ? list.slice(0, more ? 40 : 8).map((t, i) => {
          const col = (TL_KINDS.find(k => k[0] === tlKind(t)) || [])[2] || C.dim
          return el(Tip, { key: i, label: t.tip || t.what },
            el('div', { style: { display: 'flex', gap: 10, alignItems: 'center', fontSize: 11.5, color: C.sub, padding: '5px 0' } },
              el('span', { style: { width: 8, height: 8, borderRadius: 4, background: col, flex: 'none' } }),
              el('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: C.text } }, t.what),
              el('span', { style: { color: C.dim, fontSize: 10.5, flex: 'none', paddingRight: 6 } }, ago(t.ts))))
        })
      : aSmall('Nothing in this period'),
    list.length > 8 ? el(ALink, { onClick: () => setMore(!more) }, more ? 'show less' : 'show ' + (Math.min(40, list.length) - 8) + ' more') : null)
}

// AAI, v7 layout: quick look, then what needs you, then what is happening, then tools and settings
const AaiView2 = ({ profile, period, yaml, orProfile, auxOn, onChanged }) => {
  const days = AAI_DAYS[period] || 7
  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)
  const [tick, setTick] = useState(0)
  const [cases, setCases] = useState([])
  const [corr, setCorr] = useState([])
  const [gate, setGate] = useState([])
  const [busy, setBusy] = useState(null)
  const [actionsTick, setActionsTick] = useState(0)
  const [flags, setFlags] = useState([])
  const [verOpen, setVerOpen] = useState(null)
  const reload = () => setTick(t => t + 1)
  useEffect(() => {
    let live = true
    api(profileReq(profile, { path: '/api/plugins/hermetic/aai?days=' + days }))
      .then(r => live && (setData(r), setErr(null)))
      .then(() => aaiGet(profile, '/cases')).then(r => live && r && setCases(r.cases || []))
      .then(() => aaiGet(profile, '/corrections?days=30')).then(r => live && r && setCorr(r.items || []))
      .then(() => aaiGet(profile, '/gate')).then(r => live && r && setGate(r.decisions || []))
      .then(() => aaiGet(profile, '/flags?days=' + days)).then(r => live && r && setFlags(r.flags || []))
      .catch(e => live && setErr(/404|Not Found|Headless backend/i.test(String(e && e.message)) ? 'Restart Hermes to load the AAI backend: Hermes menu, Quit and Keep Windows, then reopen.' : (e && e.message) || 'Backend plugin off, restart Hermes'))
    return () => { live = false }
  }, [profile, days, tick])
  if (err) return el('div', { style: { fontSize: 11, color: C.faint, marginTop: 14 } }, err)
  if (!data) return el('div', { style: { fontSize: 11, color: C.faint, marginTop: 14 } }, 'Loading…')

  const facts = configFacts(yaml)
  const recentCut = Date.now() / 1000 - 14 * 86400
  const unused = data.skills.filter(s => !s.disabled && !s.essential && !s.loads30 && !(s.created && s.created > recentCut))
  const alwaysOn = data.skills.filter(s => !s.disabled).reduce((a, s) => a + s.desc_tokens, 0)
  const limits = data.errors.filter(e => e.status === 429)
  const byProv = {}
  for (const e of limits) byProv[e.provider] = (byProv[e.provider] || 0) + 1
  const provList = Object.entries(byProv).sort((a, b) => b[1] - a[1])
  const fallbackJob = orProfile && facts.allowFallbacks === false && limits.length >= 10
  const r = data.ratings
  const ratings = { total: r.total != null ? r.total : r.good + r.bad, low: r.low != null ? r.low : r.bad }
  const rateJob = ratings.total < 20 || ratings.low < 5
  const lastArchive = data.work.filter(w => w.job === 'archive' && !w.undo).slice(-1)[0]
  const failing = {}
  for (const c of cases) if (c.skill && c.last && c.last.ok && !c.last.passed) failing[c.skill] = (failing[c.skill] || 0) + 1
  const reverted = new Set(data.work.filter(w => w.job === 'revert').map(w => w.skill))
  const asked = gate.filter(d => d.action === 'asked' && !reverted.has(d.skill))
  const modelLine = yamlBlock(yaml, 'model').find(l => /^\s{2}default:/.test(l)) || ''
  const mainModel = modelLine.split(':').slice(1).join(':').replace(/#.*$/, '').replace(/['"]/g, '').trim()
  const altModel = /deepseek/.test(mainModel) ? 'z-ai/glm-5.3-flash' : 'deepseek/deepseek-v4.1-flash'
  const review = data.events.filter(e => e.actor !== 'agent').length
  const loadedNow = data.skills.filter(s => !s.disabled && s.loads > 0).length
  const enabled = data.skills.filter(s => !s.disabled).length
  const caseSkills = [...new Set(cases.map(c => c.skill).filter(Boolean))]

  const todo = []
  if (rateJob) todo.push(['aai-t-rate', 'Rate replies', 'input'])
  if (corr.length) todo.push(['aai-t-inbox', corr.length + (corr.length === 1 ? ' correction' : ' corrections'), 'input'])
  for (const sk of Object.keys(failing)) todo.push(['aai-t-fix-' + sk, 'Fix ' + sk, 'bad'])
  if (asked.length) todo.push(['aai-t-gate', asked.length + ' worse ' + (asked.length === 1 ? 'change' : 'changes'), 'bad'])
  if (unused.length >= 3) todo.push(['aai-t-archive', 'Archive ' + unused.length + ' skills', 'decide'])
  const jump = id => {
    setActionsTick(t => t + 1)
    // Actions may be folded: wait for the card to render, then scroll to it
    let tries = 0
    const go = () => { const n = document.getElementById(id); if (n) n.scrollIntoView({ behavior: 'smooth', block: 'start' }); else if (tries++ < 20) setTimeout(go, 50) }
    setTimeout(go, 30)
  }

  const undoArchive = async () => {
    await api(profileReq(profile, { path: '/api/plugins/hermetic/aai/archive', method: 'POST', body: { skills: lastArchive.skills, undo: true } }))
    reload()
  }

  const timeline = []
    .concat(data.events.map(e => ({ ts: e.ts, what: e.skill + ' ' + (e.action === 'create' ? 'created' : 'changed'), who: e.actor === 'agent' ? 'chat' : 'review', tip: e.actor === 'agent' ? 'changed in chat ' + (e.session || '') : 'changed by the background review' })))
    .concat(data.routing.filter(x => !x.first).map(x => ({ ts: x.ts, what: 'Routing rules changed', who: 'config', tip: JSON.stringify(x.routing) })))
    .concat(data.work.map(w => ({ ts: w.ts, what: w.job === 'archive' ? (w.undo ? 'Unarchived ' : 'Archived ') + w.skills.length + ' skills' : w.job === 'fallback' ? 'Fallback turned on' : w.job === 'prefer' ? 'Routing: ' + w.detail + ' tried first' : w.job === 'ship' ? 'Shipped a new ' + (w.skill || 'skill') + ' version' : w.job === 'revert' ? 'Reverted ' + (w.skill || 'a skill') : w.job, who: 'Hermetic', tip: w.skills ? w.skills.join(', ') : w.detail || '' })))
  const errDays = {}
  for (const e of limits) { const d = new Date(e.ts * 1000).toDateString(); errDays[d] = errDays[d] || { ts: e.ts, n: 0, p: {} }; errDays[d].n++; errDays[d].p[e.provider] = (errDays[d].p[e.provider] || 0) + 1 }
  for (const v of Object.values(errDays)) timeline.push({ ts: v.ts, what: v.n + ' rate limits', who: 'providers', tip: Object.entries(v.p).map(([k, n]) => k + ' ' + n).join(', ') })
  // skill changes that added links, code blocks or script files: worth a look when the review wrote them from pages it read
  for (const f of flags) timeline.push({ ts: f.ts, what: f.skill + ' added ' + (f.kind === 'link' ? 'a link to ' : f.kind + ' ') + f.detail, who: 'flagged', tip: 'By ' + (f.actor === 'agent' ? 'a chat' : 'the background review') + '. Worth a look when it was written from pages it read.' })
  timeline.sort((a, b) => b.ts - a.ts)
  const changedNames = Object.keys(data.changed).sort((a, b) => data.changed[b].changes - data.changed[a].changes)
  const sub = t => el('span', { style: { fontSize: 11, fontWeight: 400, color: C.dim, marginLeft: 5 } }, t)

  const counts = { ok: 0, bad: 0, warn: 0, idle: 0 }
  for (const c of cases) counts[caseStatus(c.last)[2]]++
  const testsRight = cases.length ? el('span', { style: { display: 'flex', gap: 8 } }, el('span', { style: { color: C.ok } }, counts.ok + ' pass'), counts.bad ? el('span', { style: { color: C.bad } }, counts.bad + ' fail') : null) : null

  return el('div', null,
    el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0,1fr))', gap: 8, marginTop: 14 } },
      el(Cell, { tone: null, label: 'Skill changes', value: String(data.events.length), sub: sub(review + ' review, ' + (data.events.length - review) + ' chat'), tip: 'Changes to skills in this period: by the background review or by a chat' }),
      el(Cell, { tone: limits.length >= 10 ? 'warn' : 'ok', label: 'Rate limits', value: String(limits.length), sub: sub(provList[0] ? provList[0][0] : ''), tip: provList.map(([k, n]) => k + ' ' + n).join(', ') || 'none recorded' }),
      el(Cell, { tone: null, label: 'Skills used', value: loadedNow + ' of ' + enabled, sub: '', tip: 'Enabled skills loaded at least once in this period' }),
      el(Cell, { tone: null, label: 'Always-on', value: fmtTok(alwaysOn), sub: sub('tokens per call'), tip: 'Every enabled skill description is sent with every call: about ' + fmtTok(alwaysOn * data.calls) + ' tokens over ' + data.calls + ' calls in this period' })),
    todo.length
      ? el(Section, { id: 'aai2-actions', title: 'Actions', right: el('span', { style: { display: 'flex', alignItems: 'center', gap: 5 } }, todo.map(([id, , kind]) => el('span', { key: id, style: { width: 6, height: 6, borderRadius: 3, background: kind === 'bad' ? C.bad : kind === 'decide' ? C.warn : V7.accent } })), el('span', { style: { marginLeft: 3 } }, String(todo.length))), openTick: actionsTick },
        rateJob ? el(RateTask, { profile, ratings, onChanged: null }) : null,
        corr.length ? el(InboxTask, { profile, items: corr, onChanged: reload }) : null,
        Object.entries(failing).map(([sk, n]) => el(FixTask, { key: sk, profile, skill: sk, failing: n, onDone: reload })),
        asked.length ? el(GateTask, { profile, asked, onDone: reload }) : null,
        unused.length >= 3 ? el(ArchiveTask, { profile, unused, onDone: reload }) : null,
        null)
      : null,

    el(Section, { id: 'aai2-tiles', title: 'Tests', right: testsRight }, el(TestTiles, { profile, cases, onChanged: reload, providers: orProfile ? data.providers || [] : [], altModel, auxOn, onApplied: onChanged })),
    el(Section, { id: 'aai2-timeline', title: 'Timeline', right: timeline.length ? el('span', { style: { display: 'flex', gap: 8 } }, flags.length ? el('span', { style: { color: C.warn } }, flags.length + ' flagged') : null, String(timeline.length)) : null },
      lastArchive ? el('div', { style: { fontSize: 11, color: C.dim, marginBottom: 6 } }, 'Archived ' + lastArchive.skills.length + ' skills ' + ago(lastArchive.ts) + '  ', el(ALink, { onClick: undoArchive }, 'undo')) : null,
      el(TimelineView, { items: timeline })),
    el(Section, { id: 'aai2-changed', title: 'Changed skills', right: changedNames.length ? String(changedNames.length) : null },
      changedNames.length ? el('div', { style: { fontSize: 10.5, color: C.dim, marginBottom: 4 } }, 'Click a skill to see and compare its versions') : null,
      changedNames.length
        ? changedNames.slice(0, 8).map(n => {
            const v = data.changed[n]
            const last = v.last || {}
            return el('div', { key: n },
              el(Tip, { label: v.saved + ' of ' + v.versions + ' versions saved, loaded ' + ((data.skills.find(s => s.name === n) || {}).loads || 0) + ' times' },
                el('div', { onClick: () => setVerOpen(verOpen === n ? null : n), style: { display: 'flex', gap: 8, fontSize: 11.5, padding: '4px 0', color: C.text, cursor: 'pointer' } }, el('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: verOpen === n ? V7.accent : C.text } }, n), el('span', { style: { color: C.sub } }, v.changes + '×'), el('span', { style: { color: C.dim, width: 64, textAlign: 'right', paddingRight: 6 } }, last.ts ? ago(last.ts) : ''))),
              verOpen === n ? el('div', { style: { padding: '2px 0 8px 10px' } }, el(AaiVersions, { profile, skills: [n], noTests: !caseSkills.includes(n) })) : null)
          })
        : aSmall('No skill changes in this period')),
    el(Section, { id: 'aai2-settings', title: 'Settings' }, el(AaiSettings, { profile, ratings })))
}

// ---- HDR: harness detection and response (recording only) ----------------------------------------
const HDR_TONE = { bad: C.bad, warn: C.warn, ok: C.ok }
const HDR_SEQ = [C.accent, 'var(--ui-cyan)', 'var(--ui-purple)', C.sub, C.dim, C.faint]
const hdrScore = s => el('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 5, flex: 'none' } },
  el('span', { style: { width: 44, height: 5, borderRadius: 3, background: 'rgba(255,255,255,.07)', overflow: 'hidden', display: 'inline-block' } },
    el('i', { style: { display: 'block', height: '100%', width: s + '%', background: s >= 80 ? C.bad : s >= 50 ? C.warn : C.ok } })),
  el('span', { style: { fontSize: 10.5, color: s >= 80 ? C.bad : s >= 50 ? C.warn : C.ok, width: 18, textAlign: 'right' } }, s))
const hdrLine = (key, ...kids) => el('div', { key, style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, padding: '5px 0', borderTop: '1px solid ' + C.stroke, minWidth: 0 } }, ...kids)
const hdrGrow = (main, sub) => el('span', { style: { flex: 1, minWidth: 0 } },
  el('div', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: C.text } }, main),
  sub ? el('div', { style: { fontSize: 10.5, color: C.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, sub) : null)
const hdrTag = (t, col) => el('span', { style: { fontSize: 10, padding: '1px 6px', borderRadius: 8, border: '1px solid ' + (col || C.stroke), color: col || C.sub, flex: 'none', whiteSpace: 'nowrap' } }, t)
const hdrHead = t => el('div', { style: { fontSize: 10.5, color: C.dim, margin: '12px 0 6px' } }, t)
const hdrMore = (list, n, open, setOpen) => list.length > n ? el(ALink, { onClick: () => setOpen(!open) }, open ? 'show less' : 'show all ' + list.length) : null
const hdrIn = ts => { const s = ts - Date.now() / 1000; return s <= 0 ? 'due' : s < 3600 ? 'in ' + Math.round(s / 60) + 'm' : s < 86400 ? 'in ' + Math.round(s / 3600) + 'h' : 'in ' + Math.round(s / 86400) + 'd' }
const hdrEvery = t => { const m = /every\s+(\d+)\s*m/i.exec(t || ''); if (!m) return t; const n = +m[1]; return n % 1440 === 0 ? 'every ' + (n / 1440 === 1 ? 'day' : n / 1440 + ' days') : n % 60 === 0 ? 'every ' + (n / 60 === 1 ? 'hour' : n / 60 + ' hours') : 'every ' + n + ' min' }

// Posture: one strip, a segment per setting; pick a setting to change it right here (or in Hermes Settings)
const HDR_SETTINGS = { approvals: 'config:safety', allowlist: 'config:safety', browser: 'config:browser', terminal: 'config:workspace', inbound: 'gateway', api: 'gateway', shell_hooks: 'config:advanced' }
const hdrBtn = (label, onClick, on, busy, danger) => el('button', { key: label, type: 'button', onClick, disabled: busy || on,
  style: { font: 'inherit', fontSize: 11, padding: '4px 10px', borderRadius: 7, cursor: busy || on ? 'default' : 'pointer', border: '1px solid ' + (on ? C.accent : danger ? C.bad : C.stroke),
    background: on ? 'rgba(107,132,230,.18)' : 'transparent', color: on ? C.text : danger ? C.bad : C.sub, opacity: busy && !on ? 0.5 : 1 } }, label)
const HdrPosture = ({ rows, profile, onChanged }) => {
  const rank = { bad: 0, warn: 1, ok: 2 }
  const worst = rows.slice().sort((a, b) => rank[a.tone] - rank[b.tone])[0]
  const [pick, setPick] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const selKey = pick || (worst && worst.tone !== 'ok' ? worst.key : null)
  const sel = rows.find(r => r.key === selKey)
  const run = async fn => {
    setBusy(true); setErr(null)
    try { await fn(); onChanged && onChanged() } catch (e) { setErr((e && e.message) || 'Could not save') } finally { setBusy(false) }
  }
  // the same doors Hermes' own screens use: config.set for approvals, a one-key merge into config for the rest
  const setKey = (key, value) => run(() => host.request('config.set', profile && profile !== 'default' ? { key, value, profile } : { key, value }))
  const merge = part => run(() => api(profileReq(profile, { path: '/api/config', method: 'PUT', body: { config: part } })))
  const dropAllowed = item => run(async () => {
    const cur = await api(profileReq(profile, { path: '/api/config?include_defaults=false' }))
    const list = ((cur && (cur.config || cur)) || {}).command_allowlist || []
    const next = list.filter(x => String(x).slice(0, 120) !== item)
    if (next.length === list.length) throw new Error('That entry is no longer there')
    await api(profileReq(profile, { path: '/api/config', method: 'PUT', body: { config: { command_allowlist: next } } }))
  })
  const control = r => {
    if (r.key === 'approvals') {
      // only toward asking more: off < smart < manual; loosening is done in Hermes settings
      const rank = { off: 0, yolo: 0, smart: 1, manual: 2 }
      const up = [['smart', 'Smart'], ['manual', 'Ask me']].filter(([v]) => rank[v] > (rank[r.value] != null ? rank[r.value] : 2))
      return up.length ? el('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } }, up.map(([v, l]) => hdrBtn(l, () => setKey('approvals.mode', v), false, busy))) : aSmall('Hermes asks you before risky commands.')
    }
    if (r.key === 'allowlist') return (r.items || []).length
      ? el('div', null, r.items.map((x, i) => hdrLine('a' + i, el('span', { className: 'mono', style: { flex: 1, minWidth: 0, fontSize: 10.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, x), hdrBtn('Remove', () => dropAllowed(x), false, busy, true))))
      : aSmall('Nothing is allowed permanently.')
    if (r.key === 'browser' && r.value === 'your profile') return hdrBtn('Use a separate browser profile', () => merge({ browser: { use_real_profile: false } }), false, busy)
    if (r.key === 'inbound' && r.value === 'anyone') return hdrBtn('Only people I pair', () => merge({ gateway: { allow_all_users: false } }), false, busy, true)
    if (r.key === 'api' && r.value !== 'off') return hdrBtn('Turn the API server off', () => merge({ gateway: { api_server: { enabled: false } } }), false, busy, true)
    return null
  }
  return el('div', null,
    el('div', { style: { display: 'flex', gap: 3 } }, rows.map(r => el(Tip, { key: r.key, label: r.label + ': ' + r.value + '. ' + r.why },
      el('span', { onClick: () => setPick(r.key), style: { flex: 1, height: 6, borderRadius: 3, background: HDR_TONE[r.tone] || C.faint, opacity: r.tone === 'ok' ? 0.45 : 1, cursor: 'pointer', outline: r.key === selKey ? '1px solid ' + C.text : 'none', outlineOffset: 1 } })))),
    el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0,1fr))', gap: 6, marginTop: 10 } }, rows.map(r => el(Tip, { key: r.key, label: r.why },
      el('div', { onClick: () => setPick(r.key === selKey ? '__none' : r.key), style: { display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', borderRadius: 7, cursor: 'pointer', minWidth: 0, fontSize: 11,
        background: r.key === selKey ? 'rgba(107,132,230,.14)' : 'var(--ui-bg-tertiary)', boxShadow: r.key === selKey ? 'inset 0 0 0 1px ' + C.accent : 'none' } },
        el(Dot, { tone: r.tone }), el('span', { style: { flex: 1, color: C.sub, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, r.label),
        el('span', { style: { color: HDR_TONE[r.tone] === C.ok ? C.text : HDR_TONE[r.tone], whiteSpace: 'nowrap' } }, r.value))))),
    sel ? el('div', { style: { marginTop: 8, padding: '9px 10px', borderRadius: 8, border: '1px solid ' + C.stroke } },
      el('div', { style: { fontSize: 11.5, color: C.text, lineHeight: 1.45 } }, el('span', { style: { color: HDR_TONE[sel.tone] } }, sel.label + ' ' + sel.value + '. '), sel.why),
      control(sel) ? el('div', { style: { marginTop: 8 } }, control(sel)) : null,
      el('div', { style: { display: 'flex', gap: 12, alignItems: 'center', marginTop: 8, fontSize: 10.5 } },
        HDR_SETTINGS[sel.key] ? el(ALink, { onClick: () => host.navigate('/settings?tab=' + HDR_SETTINGS[sel.key]) }, 'open in Hermes settings') : null,
        sel.key === 'terminal' && sel.value === 'local' ? el('span', { style: { color: C.dim } }, 'A container needs Docker set up first') : null,
        busy ? el('span', { style: { color: C.dim } }, 'Saving…') : null,
        err ? el('span', { style: { color: C.bad } }, err) : null))
      : null)
}

// Where data went: the same flow chart as Costs, tool kind -> destination -> seen before or new
const HDR_FAMILY = n => n === 'model requests' ? 'Model' : n === 'terminal' ? 'Terminal' : n === 'execute_code' ? 'Code' : /^browser|desktop_preview/.test(n) ? 'Browser' : n === 'delegate_task' ? 'Subagents' : /^web_|vision/.test(n) ? 'Web tools' : 'Other tools'
const HDR_FAM_COLOR = { Model: C.accent, Terminal: 'var(--ui-cyan)', Code: 'var(--ui-purple)', Browser: C.sub, 'Web tools': C.dim, Subagents: C.faint, 'Other tools': C.faint }
const hdrFlowData = list => {
  const top = list.slice().sort((a, b) => b.calls - a.calls).slice(0, 4).map(d => d.domain)
  const fam = {}, dest = {}, l1 = {}, l2 = {}
  let total = 0
  for (const d of list) {
    if (!d.calls) continue
    const dk = top.includes(d.domain) ? d.domain : 'others'
    const st = d.new ? 'new' : 'seen'
    for (const [via, n] of Object.entries(d.via_n || { [d.via[0] || 'other']: d.calls })) {
      const f = HDR_FAMILY(via)
      fam[f] = (fam[f] || 0) + n; dest[dk] = (dest[dk] || 0) + n; total += n
      l1[f + '|' + dk] = (l1[f + '|' + dk] || 0) + n
      l2[dk + '|' + st] = (l2[dk + '|' + st] || 0) + n
    }
  }
  if (!total) return null
  const famNodes = Object.entries(fam).sort((a, b) => b[1] - a[1]).map(([f, v]) => ({ id: 'f:' + f, label: f, value: v, color: HDR_FAM_COLOR[f] || C.faint }))
  const destNodes = Object.entries(dest).sort((a, b) => (a[0] === 'others') - (b[0] === 'others') || b[1] - a[1]).map(([k, v]) => ({ id: 'd:' + k, label: k === 'others' ? 'others' : k.replace(/^www\./, ''), value: v, color: C.sub, opacity: 0.55 }))
  const stNodes = [['seen', 'known', C.ok], ['new', 'new', C.warn]].filter(([k]) => Object.keys(l2).some(x => x.endsWith('|' + k))).map(([k, label, color]) => ({ id: 's:' + k, label, value: Object.entries(l2).filter(([x]) => x.endsWith('|' + k)).reduce((a, [, v]) => a + v, 0), color, forceLabel: true }))
  return {
    total,
    columns: [famNodes, destNodes, stNodes],
    links: [
      Object.entries(l1).map(([k, v]) => { const [f, dk] = k.split('|'); return { id: 'l1:' + k, source: 'f:' + f, target: 'd:' + dk, value: v, color: HDR_FAM_COLOR[f] || C.faint } }),
      Object.entries(l2).map(([k, v]) => { const [dk, st] = k.split('|'); return { id: 'l2:' + k, source: 'd:' + dk, target: 's:' + st, value: v, color: st === 'new' ? C.warn : C.ok } })
    ]
  }
}
const HdrDomains = ({ list }) => {
  const [open, setOpen] = useState(null)
  const [all, setAll] = useState(false)
  if (!list.length) return aSmall('No destinations recorded in this period')
  // model requests dwarf tool traffic, so they get one line and the chart shows what tools reached
  const model = list.filter(d => (d.via_n || {})['model requests'])
  const tools = list.map(d => { const v = { ...(d.via_n || {}) }; delete v['model requests']; return { ...d, via_n: v, calls: Object.values(v).reduce((a, n) => a + n, 0) } }).filter(d => d.calls)
  const flow = hdrFlowData(tools)
  return el('div', null,
    model.map(d => el('div', { key: d.domain, style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, padding: '2px 0 8px' } },
      el('span', { style: { width: 8, height: 8, borderRadius: 2, background: C.accent, flex: 'none' } }),
      el('span', { style: { flex: 1, minWidth: 0, color: C.text } }, 'Model requests to ' + d.domain),
      d.passed_to ? el(Tip, { label: 'OpenRouter passed them on to ' + d.passed_to.join(', ') }, el('span', { style: { fontSize: 10.5, color: C.dim, cursor: 'help' } }, d.passed_to.length + ' providers')) : null,
      el('span', { style: { color: C.sub, fontVariantNumeric: 'tabular-nums', paddingRight: 4 } }, d.via_n['model requests'].toLocaleString()))),
    flow ? el('div', { style: { fontSize: 10.5, color: C.dim, margin: '2px 0 6px' } }, 'Tools, by kind, destination and whether it was seen before') : null,
    flow ? el(Flow, { data: flow, fmtValue: v => Math.round(v).toLocaleString() + ' calls' }) : null,
    hdrHead('New first, then busiest. Click one for its chats.'),
    list.slice(0, all ? 80 : 6).map(d => el('div', { key: d.domain },
      el('div', { onClick: () => setOpen(open === d.domain ? null : d.domain), style: { cursor: 'pointer' } },
        hdrLine(d.domain, el('span', { style: { width: 7, height: 7, borderRadius: 4, flex: 'none', background: d.new ? C.warn : C.ok } }),
          hdrGrow(d.domain), d.new ? hdrTag('new', C.warn) : null,
          el('span', { style: { display: 'flex', gap: 3 } }, d.via.slice(0, 3).map(v => el(Tip, { key: v, label: v }, el('span', { style: { width: 6, height: 6, borderRadius: 2, background: HDR_FAM_COLOR[HDR_FAMILY(v)] || C.faint, display: 'inline-block' } })))),
          el('span', { style: { width: 42, textAlign: 'right', color: C.sub, fontVariantNumeric: 'tabular-nums', paddingRight: 4 } }, d.calls.toLocaleString()))),
      open === d.domain
        ? el('div', { style: { margin: '0 0 6px 15px' } },
            d.passed_to ? el('div', { style: { fontSize: 10.5, color: C.sub, marginBottom: 3 } }, 'OpenRouter passed them on to ' + d.passed_to.join(', ')) : null,
            d.chats.map(c => el('div', { key: c.title, style: { display: 'flex', fontSize: 10.5, color: C.dim, padding: '1px 0' } }, el('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, '↳ ' + c.title), c.calls)))
        : null)),
    hdrMore(list, 6, all, setAll))
}

// Files and secrets: one bar for where tools worked, then the sensitive places as tiles by kind
const HDR_KIND = w => /keys|login|keychain|vault/i.test(w) ? 'Keys and logins' : /starts programs/.test(w) ? 'Startup items' : /every shell/.test(w) ? 'Shell settings' : 'System'
const HdrFiles = ({ files, secrets }) => {
  const [open, setOpen] = useState(null)
  const roots = files.roots.slice(0, 5)
  const rest = files.total - roots.reduce((a, r) => a + r.touches, 0)
  const parts = roots.map((r, i) => ({ label: r.root, n: r.touches, color: HDR_SEQ[i] })).concat(rest > 0 ? [{ label: 'other places', n: rest, color: C.faint }] : [])
  const kinds = {}
  for (const s of files.sensitive) { const k = HDR_KIND(s.why); (kinds[k] = kinds[k] || []).push(s) }
  const tiles = ['Keys and logins', 'Startup items', 'Shell settings', 'System'].map(k => ({ k, list: kinds[k] || [] }))
  const vault = secrets.vault.length
  const sel = open && open !== 'Vault' ? (kinds[open] || []) : null
  return el('div', null,
    el('div', { style: { display: 'flex', height: 10, borderRadius: 5, overflow: 'hidden', gap: 2 } }, parts.map(p => el(Tip, { key: p.label, label: p.label + ', ' + p.n.toLocaleString() + ' touches' }, el('span', { style: { flex: p.n, background: p.color, opacity: 0.8, cursor: 'help' } })))),
    el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px 12px', marginTop: 7 } }, parts.map(p => el('span', { key: p.label, style: { display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10.5, color: C.sub } },
      el('span', { style: { width: 7, height: 7, borderRadius: 2, background: p.color } }), el('span', { className: 'mono' }, p.label), el('span', { style: { color: C.dim } }, p.n.toLocaleString())))),
    hdrHead('Sensitive places'),
    el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: 6 } },
      tiles.concat([{ k: 'Vault', list: [], n: vault }]).map(t => {
        const n = t.k === 'Vault' ? t.n : t.list.reduce((a, s) => a + s.times, 0)
        const max = t.list.reduce((a, s) => Math.max(a, s.score), t.k === 'Vault' && n ? 60 : 0)
        const writes = t.list.filter(s => s.op === 'write' || s.op === 'code').length
        const col = !n ? C.faint : max >= 80 ? C.bad : max >= 50 ? C.warn : C.ok
        return el('div', { key: t.k, onClick: () => n && setOpen(open === t.k ? null : t.k), style: { cursor: n ? 'pointer' : 'default', borderRadius: 8, padding: '7px 8px', background: open === t.k ? 'var(--ui-bg-tertiary)' : 'rgba(255,255,255,.03)', borderTop: '2px solid ' + col, opacity: n ? 1 : 0.55 } },
          el('div', { style: { fontSize: 15, fontWeight: 600, color: C.text } }, n),
          el('div', { style: { fontSize: 10.5, color: C.sub, marginTop: 1 } }, t.k),
          el('div', { style: { fontSize: 10, color: writes ? C.bad : C.dim, marginTop: 2 } }, t.k === 'Vault' ? (n ? 'browser vault uses' : 'not used') : n ? (writes ? writes + ' written' : 'read only') : 'untouched'))
      })),
    sel ? el('div', { style: { marginTop: 8 } }, sel.map((s, i) => hdrLine('s' + i, hdrGrow(el('span', { className: 'mono', style: { fontSize: 10.5 } }, s.path), s.op + ' by ' + s.tool + (s.times > 1 ? ', ' + s.times + ' times' : '') + ' in ' + s.chats.slice(0, 2).join(', ')), hdrScore(s.score)))) : null,
    open === 'Vault' ? el('div', { style: { marginTop: 8 } }, [...new Set(secrets.vault.map(v => v.chat))].map(c => hdrLine(c, hdrGrow(c), el('span', { style: { color: C.sub, paddingRight: 4 } }, secrets.vault.filter(v => v.chat === c).length)))) : null)
}

// What runs on its own: job cards with their rhythm, ports as pills per program
const HdrRuns = ({ runs }) => {
  const groups = {}
  const prog = s => { if (s.hermes) return 'Hermes backend'; const app = /\/([^/]+)\.app\//.exec(s.command); if (app) return app[1]; const b = s.command.split(/\s+/)[0].split('/').pop() || 'process'; return /chrome-headless/.test(b) ? 'headless Chrome' : b }
  for (const s of runs.services) { const k = prog(s); (groups[k] = groups[k] || []).push(s) }
  return el('div', null,
    runs.jobs.length ? runs.jobs.map(j => el('div', { key: j.name, style: { borderRadius: 8, padding: '8px 10px', background: 'var(--ui-bg-tertiary)', marginBottom: 6 } },
      el('div', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: C.text } }, el(Dot, { tone: j.new ? 'warn' : j.enabled ? 'ok' : null }), el('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, j.name),
        j.script ? hdrTag('runs a script', C.warn) : null, hdrTag(j.enabled ? 'on' : 'paused', j.enabled ? C.ok : null)),
      el('div', { style: { display: 'flex', gap: 14, fontSize: 10.5, color: C.dim, marginTop: 4, marginLeft: 15 } },
        el('span', null, hdrEvery(j.schedule)), j.next_run ? el('span', null, 'next ' + hdrIn(Date.parse(j.next_run) / 1000)) : null, j.last_status ? el('span', { style: { color: j.last_status === 'ok' ? C.dim : C.bad } }, 'last ' + j.last_status) : null, j.toolsets.length ? el(Tip, { label: 'Tools it may use: ' + j.toolsets.join(', ') }, el('span', { style: { cursor: 'help' } }, j.toolsets.length + ' toolsets')) : null))) : aSmall('No scheduled jobs'),
    hdrHead('Listening ports started under Hermes'),
    Object.keys(groups).length ? Object.entries(groups).map(([k, list]) => el('div', { key: k, style: { display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', borderTop: '1px solid ' + C.stroke } },
      el('span', { style: { width: 112, flex: 'none', fontSize: 11.5, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, k),
      el('span', { style: { display: 'flex', flexWrap: 'wrap', gap: 4, flex: 1 } }, list.map(s => el(Tip, { key: s.addr, label: s.command + (s.chat ? ', from chat "' + s.chat + '"' : '') },
        el('span', { className: 'mono', style: { fontSize: 10, padding: '1px 6px', borderRadius: 6, cursor: 'help', border: '1px solid ' + (s.exposed ? C.bad : C.stroke), color: s.exposed ? C.bad : s.chat ? C.text : C.sub } }, s.exposed ? '0.0.0.0:' + s.port : s.port)))))) : aSmall('None'),
    el('div', { style: { display: 'flex', gap: 8, marginTop: 10 } }, [[runs.subagents, 'subagents'], [runs.processes.length, 'background processes']].map(([n, t]) =>
      el('span', { key: t, style: { fontSize: 10.5, color: C.sub, padding: '3px 8px', borderRadius: 6, background: 'rgba(255,255,255,.04)' } }, el('b', { style: { color: C.text, fontWeight: 600, marginRight: 4 } }, n), t))))
}

// What shapes every prompt: a gauge per file against Hermes' own size limit
const HdrPrompt = ({ prompt }) => {
  const writers = [...new Set(prompt.memory_writes.map(w => w.chat))]
  return el('div', null,
    el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: 6 } }, prompt.files.map(f => {
      const name = f.file.split('/').pop()
      const lim = (prompt.limits || {})[name]
      const pct = lim ? Math.min(1, f.bytes / lim) : null
      const col = pct == null ? C.sub : pct >= 0.95 ? C.bad : pct >= 0.8 ? C.warn : C.ok
      return el(Tip, { key: f.file, label: f.file + ', edited ' + ago(f.modified) + (f.changed ? ', changed ' + ago(f.changed) : '') + (lim ? ', limit ' + lim + ' characters' : '') },
        el('div', { style: { borderRadius: 8, padding: '7px 8px', background: 'rgba(255,255,255,.03)', cursor: 'help' } },
          el('div', { className: 'mono', style: { fontSize: 10.5, color: C.text } }, name),
          el('div', { style: { fontSize: 15, fontWeight: 600, marginTop: 3, color: pct == null ? C.text : col } }, pct == null ? (f.bytes / 1000).toFixed(1) + 'k' : Math.round(pct * 100) + '%'),
          el('div', { style: { height: 4, borderRadius: 2, background: 'rgba(255,255,255,.07)', overflow: 'hidden', marginTop: 4 } }, el('i', { style: { display: 'block', height: '100%', width: (pct == null ? 1 : pct) * 100 + '%', background: col, opacity: pct == null ? 0.3 : 1 } })),
          el('div', { style: { fontSize: 10, color: f.changed ? C.warn : C.dim, marginTop: 4 } }, f.changed ? 'changed ' + ago(f.changed) : lim ? 'full at ' + (lim / 1000).toFixed(1) + 'k' : 'no limit')))
    })),
    el('div', { style: { display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' } },
      el(Tip, { label: writers.length ? 'From ' + writers.join(', ') : 'No chat wrote to memory' }, el('span', { style: { fontSize: 10.5, color: C.sub, padding: '3px 8px', borderRadius: 6, background: 'rgba(255,255,255,.04)', cursor: 'help' } }, el('b', { style: { color: C.text, fontWeight: 600, marginRight: 4 } }, prompt.memory_writes.length), 'memory writes from chats')),
      el('span', { style: { fontSize: 10.5, color: C.sub, padding: '3px 8px', borderRadius: 6, background: 'rgba(255,255,255,.04)' } }, el('b', { style: { color: C.text, fontWeight: 600, marginRight: 4 } }, prompt.skill_edits), 'skill edits from chats')))
}

// Plugins and middleware: where each plugin sits on the path of a model request and of a tool call
const HDR_LANES = [
  ['Every model request', [['pre_llm_call', 'adds text to the prompt'], ['llm_request', 'changes the request before it is sent'], [null, 'the model answers'], ['llm_execution', 'wraps the call itself'], ['transform_llm_output', 'rewrites the reply']]],
  ['Every tool call', [['pre_tool_call', 'can block it or ask you'], ['tool_request', 'changes what the tool gets'], [null, 'the tool runs'], ['tool_execution', 'wraps the run'], ['post_tool_call', 'sees the result'], ['transform_terminal_output', 'rewrites terminal output'], ['transform_tool_result', 'rewrites what the model sees']]]
]
const HdrPipeline = ({ list }) => {
  const on = list.filter(p => p.enabled)
  const at = point => on.filter(p => p.hooks.includes(point) || p.middleware.includes(point))
  const staged = new Set(HDR_LANES.flatMap(([, st]) => st.map(s => s[0]).filter(Boolean)))
  const chip = (p, point) => el(Tip, { key: p.name, label: p.name + (p.undeclared.includes(point) ? ': registers this without declaring it' : '') + (p.origin === 'bundled' ? ', built into Hermes' : '') },
    el('span', { style: { fontSize: 10, padding: '1px 7px', borderRadius: 8, cursor: 'help', border: '1px solid ' + (p.undeclared.includes(point) ? C.bad : C.stroke), color: p.undeclared.includes(point) ? C.bad : C.text, background: 'rgba(255,255,255,.04)' } }, p.name))
  return el('div', null,
    HDR_LANES.map(([title, stages]) => el('div', { key: title, style: { marginBottom: 10 } },
      el('div', { style: { fontSize: 10.5, color: C.dim, marginBottom: 4 } }, title),
      el('div', { style: { position: 'relative', paddingLeft: 16 } },
        el('span', { style: { position: 'absolute', left: 4, top: 6, bottom: 6, width: 1, background: C.stroke } }),
        stages.map(([point, words]) => {
          const ps = point ? at(point) : []
          return el('div', { key: point || words, style: { position: 'relative', display: 'flex', alignItems: 'center', gap: 8, minHeight: 22, fontSize: 11 } },
            el('span', { style: { position: 'absolute', left: -15, width: point ? 9 : 7, height: point ? 9 : 7, borderRadius: point ? 5 : 2, marginLeft: point ? 0 : 1,
              background: !point ? C.sub : ps.length ? (ps.some(p => p.undeclared.includes(point)) ? C.bad : C.accent) : 'var(--ui-bg-tertiary)', border: point && !ps.length ? '1px solid ' + C.faint : 'none', boxSizing: 'border-box' } }),
            el(Tip, { label: point ? point + (point.includes('_request') || point.includes('_execution') ? ' middleware' : ' hook') : 'Hermes itself' },
              el('span', { style: { flex: 1, color: !point ? C.dim : ps.length ? C.text : C.faint, fontStyle: point ? 'normal' : 'italic', cursor: 'help' } }, words)),
            el('span', { style: { display: 'flex', gap: 4, flexWrap: 'wrap', justifyContent: 'flex-end' } }, ps.map(p => chip(p, point))))
        })))),
    (() => {
      const listen = on.map(p => [p, p.hooks.filter(h => !staged.has(h))]).filter(([, hs]) => hs.length)
      return listen.length ? el('div', { style: { fontSize: 10.5, color: C.dim, marginTop: 2, lineHeight: 1.6 } }, 'Only listening: ', listen.map(([p, hs], i) => el(Tip, { key: p.name, label: hs.join(', ') }, el('span', { style: { color: C.sub, cursor: 'help', marginRight: 10 } }, p.name + ' ' + hs.length)))) : null
    })(),
    on.length < list.length ? el('div', { style: { fontSize: 10.5, color: C.dim, marginTop: 4 } }, 'Installed but off: ' + list.filter(p => !p.enabled).map(p => p.name).join(', ')) : null)
}

// Guard: one level for the calls HDR scores 70+. Ask goes through Hermes' own approval prompt; Block stops the call
const GUARD_OPTIONS = [{ id: 'watch', label: 'Watch' }, { id: 'ask', label: 'Ask' }, { id: 'block', label: 'Block' }]
const guardNoAsk = g => g.approvals === 'off' || g.approvals === 'yolo'
const guardRight = g => {
  const n = (g.stops || []).length
  const word = g.level === 'block' ? el('span', { style: { color: C.bad } }, 'blocks') : g.level === 'ask' ? el('span', { style: { color: guardNoAsk(g) ? C.dim : C.warn } }, guardNoAsk(g) ? 'asks (approvals off)' : 'asks') : el('span', { style: { color: C.dim } }, 'watching')
  return el('span', { style: { display: 'flex', gap: 8 } }, word, n ? String(n) : null)
}
const guardFoot = g => !g ? 'Recording only: nothing is blocked or changed.'
  : g.level === 'block' ? 'Guard on: risky calls are blocked, everything else is only recorded.'
  : g.level === 'ask' ? (guardNoAsk(g) ? 'Guard set to ask, but approvals are off, so nothing is stopped yet.' : 'Guard on: Hermes asks you before risky calls, everything else is only recorded.')
  : 'Recording only: nothing is blocked or changed.'
const HdrGuard = ({ g, profile, days, onChanged }) => {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const set = async level => {
    if (level === g.level || busy) return
    setBusy(true); setErr(null)
    try {
      const r = await api(profileReq(profile, { path: '/api/plugins/hermetic/hdr/guard', method: 'POST', body: { level } }))
      if (r && r.ok === false) throw new Error(r.error || 'Could not save')
      onChanged && onChanged()
    } catch (e) { setErr(/404|Not Found/i.test(String(e && e.message)) ? 'Restart Hermes to load the guard' : (e && e.message) || 'Could not save') } finally { setBusy(false) }
  }
  const n = g.risky_calls || 0
  const span = days === 1 ? 'Today' : 'In the last ' + days + ' days'
  const effect = !n ? span + ', no call scored 70 or more.'
    : g.level === 'block' ? el('span', null, span + ', this would have blocked ' + n + (n === 1 ? ' call.' : ' calls.'))
    : g.level === 'ask' ? (guardNoAsk(g) ? el('span', null, span + ', this would have ', el('span', { style: { color: C.warn } }, 'let ' + n + ' through unasked'), '.') : span + ', this would have asked you ' + n + (n === 1 ? ' time.' : ' times.'))
    : span + ', ' + n + (n === 1 ? ' risky call was' : ' risky calls were') + ' recorded.'
  return el('div', null,
    el('div', { style: { fontSize: 11, color: C.sub, marginBottom: 8 } }, 'Risky calls: reading keys and logins, writing startup items, changing shell settings (HDR score 70 or more).'),
    el('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
      el(SegmentedControl, { value: g.level, onChange: set, options: GUARD_OPTIONS }),
      busy ? aSmall('Saving…') : null),
    el('div', { style: { fontSize: 10.5, color: C.dim, marginTop: 8 } }, effect),
    g.level === 'ask' && guardNoAsk(g) ? el('div', { style: { marginTop: 8, padding: '7px 10px', borderRadius: 8, background: 'rgba(201,147,74,.1)', border: '1px solid rgba(201,147,74,.35)', fontSize: 11, color: C.sub, lineHeight: 1.45 } },
      el('span', { style: { color: C.warn } }, 'Approvals are off'), ', so Hermes can’t ask you and Ask lets the call through. Turn approvals to Smart or Ask me in Posture above.') : null,
    g.level === 'ask' && !guardNoAsk(g) ? el('div', { style: { fontSize: 10.5, color: C.dim, marginTop: 4 } }, 'Scheduled jobs and other runs with nobody to ask treat Ask as Block.') : null,
    err ? el('div', { style: { fontSize: 10.5, color: C.bad, marginTop: 6 } }, err) : null,
    (g.stops || []).length ? el('div', { style: { marginTop: 10 } },
      hdrHead(g.stops.length === 1 ? 'Stopped once' : 'Stopped ' + g.stops.length + ' times'),
      g.stops.slice(0, 5).map((x, i) => hdrLine('g' + i,
        el('span', { style: { width: 7, height: 7, borderRadius: 4, flex: 'none', background: x.action === 'block' ? C.bad : C.warn } }),
        hdrGrow(el('span', null, (x.action === 'block' ? 'Blocked: ' : 'Asked: ') + x.op + ' ', el('span', { className: 'mono', style: { fontSize: 10.5 } }, x.path)),
          x.tool + (x.chat ? ' in “' + x.chat + '”' : '') + ', ' + ago(x.ts))))) : null)
}

const HdrView = ({ profile, period }) => {
  const days = AAI_DAYS[period] || 7
  const [d, setD] = useState(null)
  const [err, setErr] = useState(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let live = true
    api(profileReq(profile, { path: '/api/plugins/hermetic/hdr?days=' + days }))
      .then(r => live && (r && r.error ? setErr(r.error) : (setD(r), setErr(null))))
      .catch(e => live && setErr(/404|Not Found/i.test(String(e && e.message)) ? 'Restart Hermes to load HDR: Hermes menu, Quit and Keep Windows, then reopen.' : (e && e.message) || 'Backend plugin off'))
    return () => { live = false }
  }, [profile, days, tick])
  if (err) return el('div', { style: { fontSize: 11, color: C.faint, marginTop: 14 } }, err)
  if (!d) return el('div', { style: { fontSize: 11, color: C.faint, marginTop: 14 } }, 'Loading…')
  const issues = d.posture.filter(p => p.tone !== 'ok')
  const newDom = d.domains.filter(x => x.new).length
  const risky = d.files.sensitive.filter(s => s.score >= 70)
  const exposed = d.runs.services.filter(s => s.exposed).length
  const full = d.prompt.files.filter(f => { const l = (d.prompt.limits || {})[f.file.split('/').pop()]; return l && f.bytes / l >= 0.8 })
  const sub = t => el('span', { style: { fontSize: 11, fontWeight: 400, color: C.dim, marginLeft: 5 } }, t)
  const dots = list => el('span', { style: { display: 'flex', alignItems: 'center', gap: 4 } }, list.map((t, i) => el('span', { key: i, style: { width: 6, height: 6, borderRadius: 3, background: HDR_TONE[t] || C.dim } })))
  const pl = (n, one, many) => n + ' ' + (n === 1 ? one : many)
  return el('div', null,
    el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0,1fr))', gap: 8, marginTop: 14 } },
      el(Cell, { tone: issues.some(p => p.tone === 'bad') ? 'bad' : issues.length ? 'warn' : 'ok', label: 'Posture', value: String(issues.length), sub: sub(issues.length === 1 ? 'setting to look at' : 'settings to look at'), tip: issues.map(p => p.label + ': ' + p.value).join(', ') || 'All settings look safe' }),
      el(Cell, { tone: newDom ? 'warn' : 'ok', label: 'Destinations', value: String(d.domains.length), sub: sub(newDom + ' new'), tip: 'Hosts that model requests and tools reached in this period; new = first seen in the last 2 days' }),
      el(Cell, { tone: risky.length ? 'warn' : 'ok', label: 'Sensitive places', value: String(d.files.sensitive.length), sub: sub(risky.length + ' scored 70+'), tip: 'Keys, logins, startup folders and shell settings that tools read or wrote' }),
      el(Cell, { tone: exposed ? 'bad' : 'ok', label: 'Runs on its own', value: String(d.runs.jobs.length + d.runs.services.length), sub: sub(pl(d.runs.jobs.length, 'job', 'jobs') + ', ' + pl(d.runs.services.length, 'port', 'ports')), tip: 'Scheduled jobs and listening ports started under Hermes' })),
    el(Section, { id: 'hdr-posture', title: 'Posture', right: dots(issues.map(p => p.tone)) }, el(HdrPosture, { rows: d.posture, profile, onChanged: () => setTick(t => t + 1) })),
    d.guard ? el(Section, { id: 'hdr-guard', title: 'Guard', right: guardRight(d.guard) }, el(HdrGuard, { g: d.guard, profile, days, onChanged: () => setTick(t => t + 1) })) : null,
    el(Section, { id: 'hdr-net', title: 'Where data went', right: el('span', { style: { display: 'flex', gap: 8 } }, newDom ? el('span', { style: { color: C.warn } }, newDom + ' new') : null, String(d.domains.length)) }, el(HdrDomains, { list: d.domains })),
    el(Section, { id: 'hdr-files', title: 'Files and secrets', right: risky.length || d.secrets.vault.length ? el('span', { style: { color: C.warn } }, risky.length + ' sensitive' + (d.secrets.vault.length ? '   ' + d.secrets.vault.length + ' vault' : '')) : null }, el(HdrFiles, { files: d.files, secrets: d.secrets })),
    el(Section, { id: 'hdr-runs', title: 'What runs on its own', right: exposed ? el('span', { style: { color: C.bad } }, exposed + ' open') : String(d.runs.jobs.length + d.runs.services.length) }, el(HdrRuns, { runs: d.runs })),
    el(Section, { id: 'hdr-prompt', title: 'What shapes every prompt', right: full.length ? el('span', { style: { color: C.warn } }, full.length + ' nearly full') : d.prompt.files.some(f => f.changed) ? el('span', { style: { color: C.warn } }, 'changed') : null }, el(HdrPrompt, { prompt: d.prompt })),
    el(Section, { id: 'hdr-plugins', title: 'Plugins and middleware', right: d.plugins.some(p => p.undeclared.length) ? el('span', { style: { color: C.bad } }, 'undeclared') : String(d.plugins.filter(p => p.enabled).length) }, el(HdrPipeline, { list: d.plugins })),
    el('div', { style: { fontSize: 10.5, color: C.dim, marginTop: 14, lineHeight: 1.45 } }, guardFoot(d.guard) + (d.learning ? ' Still learning what is normal.' : '')))
}

// direction of the view arrow, kept across renders (see the header in Body)
let navDir = 1

const Body = ({ meter, prices, threshold, retries, yaml, profile, profileLabel, refresh, rates, defaultModel, account, onPeriod, cheapest, orProfile = true, orAny = true, view = 'costs', onView, scope = 'all', profileCount = 1, onScope }) => {
  const currentId = useValue(host.state.focusedStoredSessionId) || null
  const [period, setPeriod] = useState(() => sget('period', '7d'))
  const [hover, setHover] = useState(null)
  const [pinned, setPinned] = useState(null)
  const pick = p => {
    setPeriod(p)
    setPinned(null)
    sset('period', p)
    if (onPeriod) onPeriod(p)
  }
  // Only a pinned (clicked) day re-scopes the model. Transient hover is display-only: it highlights
  // a bar and swaps the headline figure, so moving the mouse never rebuilds the sections below.
  const focus = pinned
  const shown = hover || pinned
  // OpenRouter's daily bill, drawn over the bars only where it belongs: none for a profile that is not
  // billed by OpenRouter; for one profile sharing the key, its part of each day's bill (its share of that
  // day's OpenRouter list cost), like the headline
  const billed = useMemo(() => {
    if (account == null) return null
    const raw = sget('billed', null) || {}
    if (scope === 'all' || !meter.orDaily) return raw
    const out = {}
    for (const [day, usd] of Object.entries(raw)) {
      const all = num((meter.orDaily.get(day) || {}).cost)
      const mine = num((meter.daily.get(day) || {}).cost)
      if (all > 0) out[day] = usd * Math.min(1, mine / all)
    }
    return out
  }, [account, scope, meter])
  const m = useMemo(() => computeModel(meter, period, focus, prices, threshold, defaultModel, billed), [meter, period, focus, prices, threshold, defaultModel, billed])

  const liveRate = rates.reduce((a, r) => a + r.rate, 0)
  const agents = rates.length
  const typicalHourly = m.typical / 8 // a typical active day spans roughly a working shift
  const liveTone = liveRate >= 5 ? 'bad' : liveRate >= 1.5 ? 'warn' : null
  const multiple = typicalHourly > 0 ? liveRate / typicalHourly : 0

  const acct = account ? (period === 'today' ? account.today : period === '7d' ? account.week : account.month) : null
  // Billed figures are OpenRouter's UTC calendar week / month to date, so the Hermes side is summed
  // over the same window rather than the trailing 7 / 30 days the bars show.
  const windowStart = acct != null && period !== 'today' ? accountWindowStart(period) : null
  const windowRows = windowStart ? m.series.filter(r => r.day >= windowStart) : m.series
  const periodHermes = windowRows.reduce((a, r) => a + r.cost, 0)
  const hermesCost = shown ? (m.series.find(r => r.day === shown) || { cost: 0 }).cost : m.periodCost
  // OpenRouter's bill covers every profile on the key; compare it with those profiles' list cost
  const inPeriod = new Set(m.series.map(r => r.day))
  const periodOR = meter.orDaily ? Array.from(meter.orDaily.values()).filter(r => (windowStart ? r.day >= windowStart : inPeriod.has(r.day))).reduce((a, r) => a + r.cost, 0) : periodHermes
  // Hermes books a session's cost to its start day, so a one-day comparison is attribution noise.
  const comparable = period !== 'today'
  const elsewhere = comparable && acct != null ? Math.max(0, acct - periodOR) : null
  const drift = comparable && acct != null && periodOR > 0.5 && acct > 0 ? acct / periodOR : null
  // one profile sharing the key with others gets its share of the bill (its list cost times the drift);
  // all profiles get the bill plus the list cost of profiles billed elsewhere
  const share = acct != null && !!meter.orDaily && scope !== 'all'
  const nonOR = acct != null && meter.orDaily && scope === 'all' ? Math.max(0, periodHermes - periodOR) : 0
  const pinfo = (meter.periods && meter.periods[period]) || {}
  const est = pinfo.estimated && pinfo.estimated.size ? Array.from(pinfo.estimated.entries()) : []
  const headline = shown ? hermesCost : acct != null ? (share ? (drift != null ? periodHermes * drift : periodHermes) : acct + nonOR) : periodHermes
  const lastDay = m.days[m.days.length - 1]
  const rangeLabel = period === 'today' ? 'today' : windowStart ? dayLabel(windowStart) + ' – ' + dayLabel(lastDay) : dayLabel(m.days[0]) + ' – ' + dayLabel(lastDay)
  // chats billed through more than one provider: their list cost per provider
  const byProv = {}
  for (const x of m.sessions) { const k = sessionProvider(x); if (k) byProv[k] = (byProv[k] || 0) + num(x.cost) }
  const provSplit = Object.entries(byProv).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])
  const where = acct != null ? (nonOR > 0 || provSplit.length > 1 ? 'OpenRouter and others' : 'OpenRouter') : provSplit.length > 1 ? provSplit.length + ' providers' : scope === 'all' ? 'Hermes' : meter.providerName || 'Hermes'
  const headlineLabel = shown ? dayLabel(shown) + ' on Hermes' : rangeLabel + ' on ' + where
  const periodRate = (acct != null ? acct : m.periodCost) / periodHours(period)
  // Days without a billed snapshot (Hermes desktop closed, or before the plugin existed) get a billed
  // estimate from OpenRouter's totals: the week total minus the known snapshots, spread over the
  // snapshot-less days of the week in proportion to their list cost; likewise month-minus-week for the
  // days of the month before Monday. Recomputed on every load, never stored. Drawn dashed / striped.
  const estBilled = useMemo(() => {
    const out = {}
    if (!account || (scope !== 'all' && meter.orDaily)) return out
    const weekStart = accountWindowStart('7d')
    const monthStart = accountWindowStart('30d')
    const fill = (rows, total) => {
      if (total == null) return
      const known = rows.filter(r => r.billed != null).reduce((a, r) => a + r.billed, 0)
      const unknown = rows.filter(r => r.billed == null && r.cost > 0)
      const base = unknown.reduce((a, r) => a + r.cost, 0)
      const rest = Math.max(0, total - known)
      if (rest <= 0.01 || base <= 0) return
      for (const r of unknown) out[r.day] = rest * (r.cost / base)
    }
    fill(m.series.filter(r => r.day >= weekStart), account.week)
    fill(m.series.filter(r => r.day >= monthStart && r.day < weekStart), account.month != null && account.week != null ? Math.max(0, account.month - account.week) : null)
    return out
  }, [m.series, account, scope, meter.orDaily])
  const driftTrend = m.series
    .filter(r => r.cost > 0.2 && (r.billed != null || estBilled[r.day] != null))
    .map(r => ({ v: (r.billed != null ? r.billed : estBilled[r.day]) / r.cost, est: r.billed == null }))
  const seriesView = useMemo(
    () => (!comparable || acct == null ? m.series : m.series.map(r => (r.billed == null && estBilled[r.day] != null ? { ...r, est: estBilled[r.day] } : r))),
    [m.series, acct, comparable, estBilled]
  )
  const tokensAll = m.sessions.reduce((a, x) => a + (x.synthetic ? 0 : x.input + x.output + x.cache), 0)
  const improvements = m.improvements.filter(i => orProfile || i.id !== 'aux')
  const facts = configFacts(yaml)
  // rate limits that failed outright because fallback is off (recorded by the backend hook)
  const [limits, setLimits] = useState(null)
  const fallbackOff = orProfile && facts.allowFallbacks === false
  const limitDays = AAI_DAYS[period] || 7
  useEffect(() => {
    if (!fallbackOff) return setLimits(null)
    let live = true
    aaiGet(profile, '?days=' + limitDays).then(r => {
      if (!live || !r) return
      const by = {}
      for (const e of r.errors || []) if (e.status === 429) by[e.provider] = (by[e.provider] || 0) + 1
      setLimits({ n: Object.values(by).reduce((a, b) => a + b, 0), by: Object.entries(by).sort((a, b) => b[1] - a[1]) })
    }).catch(() => {})
    return () => { live = false }
  }, [profile, limitDays, fallbackOff])
  if (fallbackOff && limits && limits.n >= 10) {
    const auxOn = !!(meter.aux && meter.aux.enabled)
    improvements.push({
      id: 'fallback',
      label: 'Turn fallback on',
      save: 0,
      metric: limits.n + ' failed',
      tip: limits.n + ' calls were rate-limited and failed because fallback is off (' + limits.by.map(([k, n]) => k + ' ' + n).join(', ') + '). With it on they retry on the next provider that passes your rules. Applies to chats started after this.',
      action: 'apply',
      change: y => ({ kind: 'provider_routing', value: Object.assign(routingStateOf(configFacts(y), auxOn), { allowFallbacks: true }) }),
      after: async () => {
        if (auxOn) await api(profileReq(profile, { path: '/api/plugins/hermetic/aux-routing', method: 'POST', body: { enabled: true } }))
        await api(profileReq(profile, { path: '/api/plugins/hermetic/aai/work', method: 'POST', body: { job: 'fallback', detail: limits.n + ' rate limits in ' + limitDays + 'd' } }))
      }
    })
  }
  const aboveList = drift != null && drift >= 1.3 ? acct - periodOR : 0
  const tollBilled = m.resets.toll * (drift != null ? drift : 1)
  if (!orProfile) {
    /* provider pinning and routing rules are OpenRouter features */
  } else if (m.resets.swaps > 0 && cheapest) {
    improvements.unshift({
      id: 'pin',
      label: 'Pin ' + shortModel(m.top ? m.top.model : '') + ' to ' + cheapest.name,
      save: aboveList + tollBilled,
      approx: true,
      action: 'apply',
      change: { kind: 'provider_only', value: cheapest.tag }
    })
  } else if (aboveList > 0) {
    improvements.unshift({
      id: 'route',
      label: 'Route to the cheapest provider',
      save: aboveList,
      approx: true,
      action: 'apply',
      change: { kind: 'provider_sort', value: 'price' }
    })
  }
  const applied = i =>
    (i.id === 'route' && facts.sort === 'price') ||
    (i.id === 'pin' && facts.only.length > 0) ||
    (i.id === 'aux' && !!facts.auxModel && /flash/i.test(facts.auxModel)) ||
    (i.id === 'fallback' && facts.allowFallbacks !== false) ||
    (i.id === 'compact' && i.change && threshold <= i.change.value + 1e-9)
  const pending = improvements.filter(i => !applied(i))
  pending.sort((a, b) => b.save - a.save)
  const topImprove = pending[0]
  let verdictTone = 'ok'
  let verdict
  if (!backendPatched && !account) {
    verdictTone = 'warn'
    verdict = 'Backend plugin off, add hermetic to plugins.enabled and restart'
  } else if (agents > 0 && liveTone) {
    verdictTone = liveTone
    verdict = agents + (agents === 1 ? ' agent' : ' agents') + ' running at ' + fmtRate(liveRate) + (multiple >= 2 ? ', ' + Math.round(multiple) + '× your usual' : '')
  } else if (agents > 0) {
    verdict = agents + (agents === 1 ? ' agent' : ' agents') + ' running at ' + fmtRate(liveRate)
  } else if (m.bloatOver) {
    verdictTone = 'warn'
    verdict = trunc(m.bloat.title, 28) + ' is past the compaction threshold'
  } else if (topImprove && topImprove.save >= 1) {
    verdict = 'Nothing burning. One fix worth ' + fmtUsd(topImprove.save, { approx: topImprove.approx }) + ' this period'
  } else {
    verdict = 'Nothing burning'
  }

  // The session with the highest average prompt size this period, as a share of its model's window,
  // against the auto-compaction threshold. Named in the label so it cannot read as the current chat.
  const bloatCell = m.bloat
    ? {
        tone: m.bloatOver ? 'warn' : 'ok',
        label: el('span', null, 'Peak context', el('span', { style: { color: C.dim, marginLeft: 6 } }, m.bloat.title || shortModel(m.bloat.model))),
        value: fmtPct(m.bloat.ctxShare * 100),
        sub: el('span', { style: { fontSize: 13, fontWeight: 400, color: C.dim, marginLeft: 4 } }, '/ ' + Math.round(threshold * 100) + '%'),
        tip: trunc(m.bloat.title, 40) + ': ' + fmtTok(m.bloat.ctxPerCall) + ' tokens per call on average ÷ ' + fmtTok(m.bloat.window) + ' window, auto-compaction at ' + Math.round(threshold * 100) + '%'
      }
    : { tone: null, label: 'Peak context', value: '-', sub: '', tip: 'No context window known for the models used this period' }

  const routingTone = m.auxShare >= 0.1 ? 'warn' : m.auxCost > 0 ? null : 'ok'
  // cache hit for the period, or the hovered / pinned day
  const cacheRows = (shown ? m.series.filter(r => r.day === shown) : m.series).reduce((a, r) => ({ input: a.input + num(r.input), cache: a.cache + num(r.cache) }), { input: 0, cache: 0 })
  const cacheHit = hitRate(cacheRows.input, cacheRows.cache)
  // prompt tokens but not one cached token all period: most likely the provider does not report cache use
  const cacheUnreported = cacheHit != null && m.series.every(r => !num(r.cache))
  const topPrice = m.top ? priceOf(prices, m.top.model) : null
  const cacheCheaper = topPrice && topPrice.cache > 0 && topPrice.in > topPrice.cache ? topPrice.in / topPrice.cache : null

  // header shared by the views: title, period, a dot per view, and the arrow to the next one
  const cardStyle = { padding: 16, fontSize: 12, color: C.text, width: 400, maxWidth: '100%', height: 'min(480px, calc(100vh - 72px))', boxSizing: 'border-box', overflowY: 'auto', scrollbarGutter: 'stable', overscrollBehavior: 'contain' }
  const isAai = view === 'aai'
  const VIEWS = [['costs', 'Costs', 'Spend, cache and provider routing'], ['aai', 'AAI', 'Skills, replies and tests'], ['hdr', 'HDR', 'What the harness touched and how exposed it is']]
  const vi = Math.max(0, VIEWS.findIndex(v => v[0] === view))
  // one arrow on the right that keeps its direction and turns around at either end:
  // Costs > AAI > HDR, then back AAI < Costs, then forward again
  const dir = vi === 0 ? 1 : vi === VIEWS.length - 1 ? -1 : navDir
  const to = VIEWS[vi + dir]
  const arrow = (to, d) => el(Tip, { key: to[0], label: to[1] + ': ' + to[2] },
    el('button', { type: 'button', 'aria-label': 'Switch to ' + to[1] + ' view', onClick: () => { navDir = dir; onView && onView(to[0]) }, className: 'hover:bg-(--ui-bg-tertiary) hover:text-(--ui-text-primary)', style: { width: 22, height: 22, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 5, border: 'none', background: 'transparent', color: C.sub, cursor: 'pointer', padding: 0 } },
      el('svg', { width: 12, height: 12, viewBox: '0 0 16 16', 'aria-hidden': true }, el('path', { d, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }))))
  const head = el(
    'div',
    { style: { display: 'flex', alignItems: 'center', gap: 8 } },
    el('span', { style: { fontSize: 11, color: C.sub } }, 'Hermetic', el('span', { style: { color: C.dim, marginLeft: 6 } }, VIEWS[vi][1])),
    el('span', { style: { flex: 1 } }),
    el(SegmentedControl, {
      value: period,
      onChange: pick,
      options: [
        { id: 'today', label: 'Today' },
        { id: '7d', label: '7d' },
        { id: '30d', label: '30d' }
      ]
    }),
    el('span', { style: { display: 'inline-flex', gap: 4, alignItems: 'center' } },
      VIEWS.map(([id, name, what], i) => el(Tip, { key: id, label: name + ': ' + what },
        el('button', { type: 'button', 'aria-label': 'Show the ' + name + ' view', onClick: () => onView && onView(id), style: { width: 6, height: 6, padding: 0, border: 'none', borderRadius: 3, cursor: 'pointer', background: i === vi ? C.text : C.faint } })))),
    arrow(to, dir > 0 ? 'm6 3 5 5-5 5' : 'm10 3-5 5 5 5')
  )
  if (view === 'hdr') return el('div', { style: cardStyle }, head, el(HdrView, { profile, period }))
  if (isAai) return el('div', { style: cardStyle }, head, el(AaiView2, { profile, period, yaml, orProfile, auxOn: !!(meter.aux && meter.aux.enabled), onChanged: refresh }))
  return el(
    'div',
    { style: cardStyle },
    head,
    el(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: 8, margin: '14px 0 10px', fontSize: 12 } },
      el(Dot, { tone: verdictTone }),
      el('span', { style: { color: C.text } }, verdict)
    ),
    el(
      'div',
      { style: { display: 'flex', alignItems: 'baseline', gap: 10, minHeight: 34, whiteSpace: 'nowrap' } },
      el(Tip, { label: (est.length ? 'Hermes has no price for ' + est.map(([m]) => m).join(', ') + '; estimated at OpenRouter list price for ' + est.map(([, id]) => id).join(', ') + '. ' : pinfo.unpriced && !headline ? 'Hermes has no price for this provider and no matching OpenRouter price was found. ' : '') + (shown ? 'List-price estimate for that day' : share ? 'Share of the OpenRouter bill for this profile: list cost times the pricing drift' : nonOR > 0 ? 'OpenRouter bill plus the list cost of profiles billed elsewhere (' + fmtUsd(nonOR) + ')' : '') },
        el('span', { style: { fontSize: 26, fontWeight: 500, letterSpacing: '-0.01em', fontVariantNumeric: 'tabular-nums' } }, (pinfo.unpriced && !est.length && !headline ? 'no price' : fmtUsd(headline, { approx: est.length > 0 || (!shown && ((share && drift != null) || nonOR > 0)) })))),
      provSplit.length > 1
        ? el(Tip, { label: 'List cost by provider: ' + provSplit.map(([k, v]) => k + ' ' + fmtUsd(v)).join(', ') }, el('span', { style: { fontSize: 11, color: C.sub, cursor: 'help', borderBottom: '1px dotted ' + C.faint } }, headlineLabel))
        : el('span', { style: { fontSize: 11, color: C.sub } }, headlineLabel),
      profileCount > 1 && onScope
        ? el(Tip, { label: scope === 'all' ? 'Every profile added up. Click to show only this chat\'s profile' : 'Only this chat\'s profile. Click to add up every profile' },
            el('button', { type: 'button', onClick: () => onScope(scope === 'all' ? 'profile' : 'all'), style: { font: 'inherit', fontSize: 10.5, padding: '1px 7px', borderRadius: 8, cursor: 'pointer', border: '1px solid ' + C.stroke, background: 'transparent', color: C.sub, whiteSpace: 'nowrap' } },
              scope === 'all' ? 'all profiles' : profileLabel || profile))
        : null,
      el(
        'span',
        {
          title: agents ? 'live, last 10 minutes' : 'average over the period',
          style: { marginLeft: 'auto', fontSize: 11, color: liveTone ? (liveTone === 'bad' ? C.bad : C.warn) : C.sub, fontVariantNumeric: 'tabular-nums' }
        },
        agents ? fmtRate(liveRate) + '\u2003' + agents + (agents === 1 ? ' agent' : ' agents') : fmtRate(periodRate)
      )
    ),
    acct != null
      ? el(
          'div',
          { style: { display: 'flex', gap: 14, marginTop: 4, fontSize: 11, color: C.sub, fontVariantNumeric: 'tabular-nums', minHeight: 16 } },
          comparable ? el('span', null, 'Hermes ', el('span', { style: { color: C.text } }, fmtUsd(shown ? hermesCost : periodHermes))) : null,
          elsewhere != null && elsewhere > 0.01 ? el('span', { title: 'billed minus the list-price estimate: the cost of being routed to pricier providers' }, 'routing premium ', el('span', { style: { color: C.text } }, fmtUsd(elsewhere))) : null,
          account && account.limit
            ? el(
                'span',
                {
                  style: { marginLeft: 'auto' },
                  title: fmtUsd(account.remaining) + ' left' + (account.week ? ', ~' + Math.max(0, account.remaining / (account.week / 7)).toFixed(1) + ' days at this week\'s pace' : '')
                },
                fmtUsd(account.limit - account.remaining) + ' used / $' + Math.round(account.limit)
              )
            : null
        )
      : null,
    account && account.limit
      ? el('div', { style: { marginTop: 8 }, title: fmtUsd(account.remaining) + ' left of the API key quota' }, el(Track, { value: 1 - account.remaining / account.limit, height: 3, tone: account.remaining / account.limit <= 0.05 ? 'bad' : account.remaining / account.limit < 0.15 ? 'warn' : null }))
      : null,
    period === 'today'
      ? el(
          'div',
          { style: { marginTop: 14 }, title: m.typical > 0 ? 'typical day ' + fmtUsd(m.typical) + ' at the tick' : 'no earlier days yet' },
          el(Track, { value: m.typical > 0 ? Math.min(1, m.todayCost / (m.typical * 2)) : 0, tick: m.typical > 0 ? 0.5 : null, height: 5 })
        )
      : el(
          'div',
          null,
          el(Bars, { series: seriesView, hoverDay: hover, onHover: setHover, onPin: d => setPinned(pinned === d ? null : d), pinned }),
          el(
            'div',
            { style: { display: 'flex', justifyContent: 'space-between', marginTop: 4, fontSize: 10, color: C.faint, fontVariantNumeric: 'tabular-nums' } },
            period === '7d'
              ? m.days.map(d => el('span', { key: d, style: { color: shown === d ? C.text : C.faint } }, weekday(d)))
              : [el('span', { key: 'a' }, dayLabel(m.days[0])), el('span', { key: 'b' }, dayLabel(m.days[m.days.length - 1]))]
          )
        ),
    el(
      'div',
      { style: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0,1fr))', gap: 8, marginTop: 14 } },
      el(Cell, { tone: bloatCell.tone, label: bloatCell.label, value: bloatCell.value, sub: bloatCell.sub, tip: bloatCell.tip }),
      drift != null
        ? el(Cell, {
            tone: drift >= 2 ? 'bad' : drift >= 1.3 ? 'warn' : 'ok',
            label: 'Pricing drift',
            value: drift.toFixed(1) + '×',
            sub:
              driftTrend.length >= 2
                ? el('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 6, fontSize: 11, fontWeight: 400 } }, el(TrendLine, { values: driftTrend, inline: true }), el(DriftDelta, { values: driftTrend }))
                : drift >= 1.3
                  ? 'pricier providers'
                  : 'list price',
            tip:
              'OpenRouter billed ' + fmtUsd(acct) + ', list-price estimate ' + fmtUsd(periodHermes) +
              (driftTrend.length >= 2 ? ', trend: ' + driftTrend.length + ' days, ' + driftTrend.filter(trendEst).length + ' estimated' : '') +
              (tokensAll > 0 ? ', ≈ ' + fmtUsd(acct / (tokensAll / 1e6)) + ' per M tokens billed vs ' + fmtUsd(periodHermes / (tokensAll / 1e6)) + ' list' : '') +
              (m.auxCost > 0 ? ', aux on paid lane ' + fmtUsd(m.auxCost) : '')
          })
        : el(Cell, {
            tone: routingTone,
            label: orAny ? 'Routing' : 'Background',
            value: m.auxCost > 0 ? fmtUsd(m.auxCost) : 'clean',
            sub: m.auxCost > 0 ? 'aux on paid lane' : '',
            tip: 'Background review, compression and title generation billed on paid models (' + fmtPct(m.auxShare * 100) + ' of spend)'
          }),
      el(Cell, {
        tone: cacheHit == null || cacheUnreported ? null : cacheHit >= 0.9 ? 'ok' : cacheHit >= 0.75 ? 'warn' : 'bad',
        label: 'Cache hit',
        value: cacheUnreported ? 'not reported' : fmtHit(cacheHit),
        sub: m.resets.total ? m.resets.total + (m.resets.total === 1 ? ' reset' : ' resets') + '\u2003' + fmtUsd(m.resets.toll * (drift != null ? drift : 1)) : '',
        tip: cacheUnreported
          ? 'No cached tokens were reported this period. ' + (meter.providerName || 'This provider') + ' may not report cache use, or nothing was cached.'
          : (cacheHit == null
            ? 'No prompt tokens in this period. '
            : fmtTok(cacheRows.cache) + ' of ' + fmtTok(cacheRows.cache + cacheRows.input) + ' prompt tokens came from the provider\'s cache' + (shown ? ' on ' + dayLabel(shown) : ' this period') + (cacheCheaper ? ', about ' + Math.round(cacheCheaper) + '× cheaper than fresh input for ' + shortModel(m.top.model) : '') + '. ') +
          'Resets, calls that re-sent the whole context: ' + m.resets.swaps + (orAny ? ' provider swaps, ' : ' cache misses, ') + m.resets.compactions + ' after compaction, retries in 30 days: ' + retries
      }),
      el(Cell, {
        tone: null,
        label: 'Top',
        value: m.top ? trunc(m.top.title.replace(/^Subagent:\s*/i, ''), 16) : '-',
        sub: m.top && m.totalSessCost > 0 ? fmtPct((m.top.cost / m.totalSessCost) * 100) : '',
        tip: m.top ? fmtUsd(m.top.cost) + ', ' + shortModel(m.top.model) + ', ' + m.top.calls + ' calls' : ''
      })
    ),
    el(SessionsSection, { m, threshold, currentId }),
    el(FlowSection, { m, drift }),
    el(RoutingSection, {
      policyOn: orProfile,
      providerName: meter.providerName,
      rows: meter.routing ? meter.routing.rows : [],
      since: meter.routing ? meter.routing.since : null,
      recording: !!(meter.routing && meter.routing.recording),
      reachable: !!(meter.routing && meter.routing.reachable),
      endpoints: meter.endpoints || {},
      prices,
      days: m.days,
      yaml,
      aux: meter.aux || null,
      health: meter.health || [],
      profile,
      profileLabel,
      onApplied: refresh
    }),
    pending.length ? el(Improve, { items: pending, yaml, profile, onApplied: refresh }) : null
  )
}

const SessionsSection = ({ m, threshold, currentId }) => {
  const [all, setAll] = useState(false)
  const [hover, setHover] = useState(null)
  const current = currentId ? m.sessions.find(x => x.id === currentId) : null
  const ordered = current ? [current].concat(m.sessions.filter(x => x.id !== current.id)) : m.sessions
  const rows = all ? ordered : ordered.slice(0, 5)
  return el(
    Section,
    { id: 'sessions', title: 'Sessions' },
    el(Scatter, { sessions: m.sessions, threshold, hover, onHover: setHover, currentId: current ? current.id : null }),
    el(
      'div',
      { style: { display: 'grid', gridTemplateColumns: 'minmax(0,1.5fr) 52px minmax(0,1fr) 30px 46px', gap: 8, fontSize: 10, color: C.faint, paddingBottom: 2 } },
      el('span', null, ''),
      el('span', { style: { textAlign: 'right' } }, '$'),
      el('span', null, 'context'),
      el('span', { style: { textAlign: 'right' } }, '↺'),
      el('span', { style: { textAlign: 'right' } }, '$/h')
    ),
    rows.map(s => el(SessionRow, { key: s.id, s, threshold, hot: hover === s.id, onHover: setHover, current: current && s.id === current.id })),
    m.sessions.length > 5
      ? el(
          'button',
          { type: 'button', onClick: () => setAll(!all), style: { background: 'transparent', border: 'none', padding: '8px 0 0', color: C.sub, fontSize: 11, cursor: 'pointer' } },
          all ? 'show fewer' : 'show all ' + m.sessions.length
        )
      : null
  )
}

const MODEL_COLORS = [C.accent, 'var(--ui-green)', 'var(--ui-purple)', 'var(--ui-cyan)', 'var(--ui-orange)']
const KIND_COLOR = { chat: C.accent, subagent: C.warn, background: C.dim }
const KIND_LABEL = { chat: 'chats', subagent: 'subagents', background: 'background' }
const TOKEN_LABEL = { context: 'context', output: 'output', input: 'input' }

// Build nodes and links for models → kinds → token types, all in list-price dollars.
function flowData(m) {
  const byModel = new Map()
  const mk = new Map() // model|kind -> $
  const kt = new Map() // kind|token -> $
  const add = (map, key, v) => map.set(key, (map.get(key) || 0) + v)
  const tokens = { context: 0, output: 0, input: 0 }
  for (const sess of m.sessions) {
    if (sess.synthetic || !sess.price) continue
    const p = sess.price
    const ctx = (sess.cache * (p.cache != null ? p.cache : p.in)) / 1e6
    const out = (sess.output * p.out) / 1e6
    const inp = (sess.input * p.in) / 1e6
    const total = ctx + out + inp
    if (total <= 0) continue
    tokens.context += sess.cache
    tokens.output += sess.output
    tokens.input += sess.input
    const model = sess.model || 'unknown'
    add(byModel, model, total)
    add(mk, model + '|' + sess.kind, total)
    add(kt, sess.kind + '|context', ctx)
    add(kt, sess.kind + '|output', out)
    add(kt, sess.kind + '|input', inp)
  }
  for (const [model, tasks] of m.auxByModel || []) {
    for (const [, c] of tasks) {
      if (c.cost <= 0) continue
      add(byModel, model, c.cost)
      add(mk, model + '|background', c.cost)
      tokens.input += c.input
      tokens.output += c.output
      const tok = c.input + c.output
      add(kt, 'background|input', tok > 0 ? (c.cost * c.input) / tok : c.cost / 2)
      add(kt, 'background|output', tok > 0 ? (c.cost * c.output) / tok : c.cost / 2)
    }
  }
  const total = Array.from(byModel.values()).reduce((a, v) => a + v, 0)
  if (total <= 0) return null
  // models under 2% merge into "other"
  const models = Array.from(byModel.entries()).sort((a, b) => b[1] - a[1])
  const keep = models.filter(([, v]) => v / total >= 0.02).map(([k]) => k)
  const alias = k => (keep.includes(k) ? k : 'other')
  const modelNodes = keep.map((k, i) => ({ id: 'm:' + k, label: shortModel(k), value: byModel.get(k), color: MODEL_COLORS[i % MODEL_COLORS.length] }))
  const otherValue = models.filter(([k]) => !keep.includes(k)).reduce((a, [, v]) => a + v, 0)
  if (otherValue > 0) modelNodes.push({ id: 'm:other', label: 'other', value: otherValue, color: C.dim })
  const kinds = ['chat', 'subagent', 'background']
  const kindNodes = kinds.map(k => ({ id: 'k:' + k, label: KIND_LABEL[k], value: 0, color: KIND_COLOR[k] }))
  const tokenKinds = ['context', 'output', 'input']
  const tokenNodes = tokenKinds.map(t => ({ id: 't:' + t, label: TOKEN_LABEL[t], value: 0, tokens: tokens[t], color: t === 'context' ? C.accent : t === 'output' ? C.accent : C.dim, opacity: t === 'output' ? 0.45 : 1 }))
  const links1 = []
  for (const [key, v] of mk) {
    const [model, kind] = key.split('|')
    const src = 'm:' + alias(model)
    const dst = 'k:' + kind
    const ex = links1.find(l => l.source === src && l.target === dst)
    if (ex) ex.value += v
    else links1.push({ source: src, target: dst, value: v, color: KIND_COLOR[kind] })
    kindNodes.find(n => n.id === dst).value += v
  }
  const links2 = []
  for (const [key, v] of kt) {
    const [kind, tok] = key.split('|')
    if (v <= 0) continue
    links2.push({ source: 'k:' + kind, target: 't:' + tok, value: v, color: KIND_COLOR[kind] })
    tokenNodes.find(n => n.id === 't:' + tok).value += v
  }
  return { total, columns: [modelNodes.filter(n => n.value > 0), kindNodes.filter(n => n.value > 0), tokenNodes.filter(n => n.value > 0)], links: [links1, links2] }
}

const Flow = ({ data, scale, onSelect, selected, fmtValue }) => {
  const [hover, setHover] = useState(null)
  const W = 400
  const H = 176
  const NW = 16
  const GAP = 6
  const xs = [0, 154, 310]
  const labelX = [22, 176, 332]
  const colTotal = data.total
  // reserve the gaps and minimum heights of the busiest column so nothing is pushed past the bottom
  const maxN = Math.max.apply(null, data.columns.map(c => c.length).concat([3]))
  const avail = H - GAP * (maxN - 1) - 4 - (maxN > 3 ? 3 * maxN : 0)
  const layout = data.columns.map((nodes, ci) => {
    let y = 4
    return nodes.map(n => {
      const h = Math.max(3, (n.value / colTotal) * avail)
      const node = { ...n, x: xs[ci], y, h, col: ci }
      y += h + GAP
      return node
    })
  })
  const byId = new Map(layout.flat().map(n => [n.id, n]))
  // stack link offsets at both ends, in target/source order
  const outOff = new Map()
  const inOff = new Map()
  const ribbons = []
  data.links.forEach((links, li) => {
    const order = links.slice().sort((a, b) => {
      const sa = byId.get(a.source).y - byId.get(b.source).y
      return sa !== 0 ? sa : byId.get(a.target).y - byId.get(b.target).y
    })
    for (const l of order) {
      const sN = byId.get(l.source)
      const tN = byId.get(l.target)
      if (!sN || !tN) continue
      const h = (l.value / colTotal) * avail
      const sy = sN.y + (outOff.get(l.source) || 0)
      const ty = tN.y + (inOff.get(l.target) || 0)
      outOff.set(l.source, (outOff.get(l.source) || 0) + h)
      inOff.set(l.target, (inOff.get(l.target) || 0) + h)
      const x0 = sN.x + NW
      const x1 = tN.x
      const cx = (x0 + x1) / 2
      ribbons.push({
        ...l,
        id: l.source + '>' + l.target,
        d: 'M' + x0 + ' ' + sy + ' C ' + cx + ' ' + sy + ', ' + cx + ' ' + ty + ', ' + x1 + ' ' + ty + ' L' + x1 + ' ' + (ty + h) + ' C ' + cx + ' ' + (ty + h) + ', ' + cx + ' ' + (sy + h) + ', ' + x0 + ' ' + (sy + h) + ' Z'
      })
    }
  })
  const related = id => {
    if (!id) return null
    const set = new Set([id])
    for (const r of ribbons) if (r.source === id || r.target === id || r.id === id) set.add(r.id).add(r.source).add(r.target)
    return set
  }
  const rel = related(hover)
  const dim = id => (rel ? (rel.has(id) ? 1 : 0.18) : 1)
  const hovered = hover ? byId.get(hover) || ribbons.find(r => r.id === hover) : null
  const fmt = v => (fmtValue ? fmtValue(v) : fmtUsd(v * scale)) + '\u2003' + fmtPct((v / colTotal) * 100)
  let tip = null
  if (hovered) {
    const node = byId.get(hover)
    const text1 = node ? node.label : byId.get(hovered.source).label + ' → ' + byId.get(hovered.target).label
    const text2 = fmt(hovered.value) + (node && node.hit != null ? '\u2003' + fmtHit(node.hit) + ' cached' : '')
    const w = Math.max(text1.length * 6.6, text2.length * 6.4) + 24
    const ax = node ? node.x + NW + 6 : (byId.get(hovered.source).x + byId.get(hovered.target).x) / 2
    const ay = node ? node.y + node.h / 2 : (byId.get(hovered.source).y + byId.get(hovered.target).y) / 2
    const text3 = hovered.note || null
    const w3 = text3 ? Math.min(W, Math.max(w, text3.length * 5.9 + 24)) : w
    const th = text3 ? 48 : 34
    tip = { x: Math.max(0, Math.min(ax, W - w3)), y: Math.max(0, Math.min(ay - 17, H - th - 2)), w: w3, h: th, text1, text2, text3 }
  }
  return el(
    'svg',
    { width: '100%', viewBox: '0 0 ' + W + ' ' + H, 'aria-hidden': true, style: { display: 'block' }, onMouseLeave: () => setHover(null) },
    el(
      'defs',
      null,
      el('pattern', { id: 'orm-hatch', width: 4, height: 4, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, el('rect', { width: 1.4, height: 4, fill: C.dim }))
    ),
    ribbons.map(r =>
      el('path', {
        key: r.id,
        d: r.d,
        fill: r.color,
        fillOpacity: (hover === r.id ? 0.5 : r.excluded ? 0.25 : 0.2) * dim(r.id),
        onMouseEnter: () => setHover(r.id),
        style: { transition: 'fill-opacity 120ms' }
      })
    ),
    layout.flat().map(n =>
      el(
        'g',
        { key: n.id, onMouseEnter: () => setHover(n.id), onClick: onSelect ? () => onSelect(n.id) : undefined, style: onSelect && n.selectable ? { cursor: 'pointer' } : undefined },
        el('rect', {
          x: n.x,
          y: n.y,
          width: NW,
          height: n.h,
          rx: 3,
          fill: n.excluded ? 'url(#orm-hatch)' : n.color,
          fillOpacity: (n.excluded ? 1 : n.opacity == null ? 0.9 : n.opacity) * dim(n.id),
          stroke: hover === n.id || selected === n.id ? C.text : n.excluded ? C.dim : 'none',
          strokeWidth: hover === n.id || selected === n.id ? 1.5 : 1,
          strokeOpacity: dim(n.id)
        }),
        n.h >= 14 || n.forceLabel
          ? el(
              'text',
              { x: labelX[n.col], y: n.y + n.h / 2 + 4, fontSize: 10, fill: n.excluded ? C.faint : C.sub, fillOpacity: dim(n.id), style: n.excluded && n.col === 1 ? { textDecoration: 'line-through' } : undefined },
              n.label + ' ' + fmtPct((n.value / colTotal) * 100) + (n.suffix || '')
            )
          : null
      )
    ),
    tip
      ? el(
          'g',
          { style: { pointerEvents: 'none' } },
          el('rect', { x: tip.x, y: tip.y, width: tip.w, height: tip.h, rx: 5, fill: 'var(--ui-bg-elevated, var(--ui-bg-tertiary))', stroke: C.stroke }),
          el('text', { x: tip.x + 8, y: tip.y + 13, fontSize: 11, fill: C.text, fontWeight: 500 }, tip.text1),
          el('text', { x: tip.x + 8, y: tip.y + 27, fontSize: 10, fill: C.sub, fontVariantNumeric: 'tabular-nums' }, tip.text2),
          tip.text3 ? el('text', { x: tip.x + 8, y: tip.y + 41, fontSize: 10, fill: C.dim }, tip.text3) : null
        )
      : null
  )
}

const FlowSection = ({ m, drift }) => {
  const data = useMemo(() => flowData(m), [m])
  return el(
    Section,
    { id: 'flow', title: 'Breakdown' },
    data ? el(Flow, { data, scale: drift != null ? drift : 1 }) : el('div', { style: { fontSize: 11, color: C.faint } }, '-')
  )
}

// ---- providers: model → upstream provider → region, with the routing policy ----

function routingData(rows, endpoints, prices, days, excl, exclWho) {
  const dayset = new Set(days)
  const add = (map, key, v) => map.set(key, (map.get(key) || 0) + v)
  const byModel = new Map()
  const byProv = new Map()
  const byRegion = new Map()
  const mp = new Map()
  const pr = new Map()
  const provCalls = new Map()
  const provIn = new Map()
  const provCache = new Map()
  let usd = 0
  let calls = 0
  let unpriced = 0
  for (const r of rows) {
    if (!dayset.has(r.day)) continue
    const model = r.model || 'unknown'
    const prov = r.upstream || 'unknown'
    const region = regionOf(prov)
    const c = routingRowCost(r, endpoints, prices)
    usd += c.usd
    calls += r.calls
    if (!c.priced) unpriced += r.calls
    add(provCalls, prov, r.calls)
    add(provIn, prov, num(r.input))
    add(provCache, prov, num(r.cache))
    add(byModel, model, c.usd)
    add(byProv, prov, c.usd)
    add(byRegion, region, c.usd)
    add(mp, model + '|' + prov, c.usd)
    add(pr, prov + '|' + region, c.usd)
  }
  if (!calls) return null
  // $ when priced, else calls
  const byCalls = usd <= 0
  if (byCalls) {
    byModel.clear(); byProv.clear(); byRegion.clear(); mp.clear(); pr.clear()
    for (const r of rows) {
      if (!dayset.has(r.day)) continue
      const model = r.model || 'unknown'
      const prov = r.upstream || 'unknown'
      add(byModel, model, r.calls); add(byProv, prov, r.calls); add(byRegion, regionOf(prov), r.calls)
      add(mp, model + '|' + prov, r.calls); add(pr, prov + '|' + regionOf(prov), r.calls)
    }
  }
  const total = Array.from(byModel.values()).reduce((a, v) => a + v, 0)
  if (total <= 0) return null
  const models = Array.from(byModel.entries()).sort((a, b) => b[1] - a[1])
  const modelNodes = models.map(([k, v], i) => ({ id: 'm:' + k, label: shortModel(k), value: v, color: MODEL_COLORS[i % MODEL_COLORS.length] }))
  // History stays; what the current policy would no longer allow is marked. A provider or region
  // counts as excluded only when every model it served is excluded there.
  const mpWhy = new Map()
  if (excl) for (const key of mp.keys()) {
    const [model, prov] = key.split('|')
    const why = excl(model, prov)
    if (why) mpWhy.set(key, why)
  }
  const provWhy = new Map()
  const provAll = new Map()
  for (const [key, v] of mp) {
    const prov = key.split('|')[1]
    const cur = provAll.get(prov) || { all: true, why: null, top: -1 }
    if (!mpWhy.has(key)) cur.all = false
    else if (v > cur.top) { cur.why = mpWhy.get(key); cur.top = v }
    provAll.set(prov, cur)
  }
  for (const [prov, x] of provAll) if (x.all && x.why) provWhy.set(prov, x.why)
  const note = why => (exclWho ? 'excluded for ' + exclWho : 'excluded') + ': ' + why
  // Providers and regions under 3% merge into one "others" box; every provider stays listed in `provs`.
  const MIN_SHARE = 0.03
  const provs = Array.from(byProv.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => ({ id: 'p:' + k, name: k, value: v, share: v / total, region: regionOf(k), calls: provCalls.get(k) || 0, hit: hitRate(provIn.get(k), provCache.get(k)), excluded: provWhy.get(k) || null, note: provWhy.has(k) ? note(provWhy.get(k)) : originNote(k) }))
  const bigProv = new Set(provs.filter(p => p.share >= MIN_SHARE).map(p => p.name))
  const smallProvs = provs.filter(p => !bigProv.has(p.name))
  if (smallProvs.length === 1) bigProv.add(smallProvs[0].name)
  const pAlias = k => (bigProv.has(k) ? 'p:' + k : 'p:__other')
  const provNodes = provs.filter(p => bigProv.has(p.name)).map(p => ({ id: p.id, label: p.name, value: p.value, color: regionColor(p.region), selectable: true, calls: p.calls, hit: p.hit, excluded: !!p.excluded, note: p.note }))
  const restProvs = provs.filter(p => !bigProv.has(p.name))
  // the list right under the chart is this box opened up
  if (restProvs.length) provNodes.push({ id: 'p:__other', label: 'others', suffix: ' \u2193', value: restProvs.reduce((a, p) => a + p.value, 0), color: C.dim, opacity: 0.5, forceLabel: true, excluded: restProvs.every(p => p.excluded) })
  const regions = Array.from(byRegion.entries()).sort((a, b) => b[1] - a[1])
  const bigRegion = new Set(regions.filter(([, v]) => v / total >= MIN_SHARE).map(([k]) => k))
  const smallRegions = regions.filter(([k]) => !bigRegion.has(k))
  if (smallRegions.length === 1) bigRegion.add(smallRegions[0][0])
  const rAlias = k => (bigRegion.has(k) ? 'r:' + k : 'r:__other')
  const regionOut = k => provs.filter(p => p.region === k).every(p => p.excluded)
  const regionWho = k => {
    const list = provs.filter(p => p.region === k)
    const head = list.slice(0, 3).map(p => p.name + ' ' + fmtShare(p.share)).join(', ')
    return list.length > 3 ? head + ' and ' + (list.length - 3) + ' more' : head
  }
  const regionNodes = regions.filter(([k]) => bigRegion.has(k)).map(([k, v]) => ({ id: 'r:' + k, label: REGION_LABEL[k] || k, value: v, color: regionColor(k), excluded: regionOut(k), note: regionOut(k) ? (exclWho ? 'excluded for ' + exclWho : 'excluded') + ': every provider here' : regionWho(k) }))
  const restRegions = regions.filter(([k]) => !bigRegion.has(k))
  if (restRegions.length) regionNodes.push({ id: 'r:__other', label: 'other', note: restRegions.map(([k, v]) => (REGION_LABEL[k] || k) + ' ' + fmtShare(v / total)).join(', '), value: restRegions.reduce((a, [, v]) => a + v, 0), color: C.dim, opacity: 0.5, forceLabel: true })
  const merge = (map, src, dst, v, color, why) => {
    const key = src + '>' + dst
    const ex = map.get(key)
    if (ex) ex.value += v
    else map.set(key, { source: src, target: dst, value: v, color, excluded: !!why, note: why ? note(why) : null })
  }
  const l1 = new Map()
  for (const [key, v] of mp) {
    const [model, prov] = key.split('|')
    const dst = pAlias(prov)
    const why = dst === 'p:__other' ? null : mpWhy.get(key)
    merge(l1, 'm:' + model, dst, v, dst === 'p:__other' ? C.dim : why ? C.faint : regionColor(regionOf(prov)), why)
  }
  const l2 = new Map()
  for (const [key, v] of pr) {
    const [prov, region] = key.split('|')
    const dst = rAlias(region)
    const why = pAlias(prov) === 'p:__other' || dst === 'r:__other' ? null : provWhy.get(prov)
    merge(l2, pAlias(prov), dst, v, dst === 'r:__other' ? C.dim : why ? C.faint : regionColor(region), why)
  }
  return {
    total,
    usd,
    calls,
    unpriced,
    byCalls,
    provs,
    restProvs,
    topModel: models[0] ? models[0][0] : null,
    columns: [modelNodes, provNodes, regionNodes],
    links: [Array.from(l1.values()), Array.from(l2.values())]
  }
}

const SORT_CHOICES = [
  { v: null, label: 'default' },
  { v: 'price', label: 'price' },
  { v: 'throughput', label: 'throughput' },
  { v: 'latency', label: 'latency' }
]

const Seg = ({ options, value, onChange }) =>
  el(
    'div',
    { style: { display: 'inline-flex', background: 'var(--ui-bg-tertiary)', borderRadius: 6, padding: 2, gap: 2 } },
    options.map(o =>
      el(
        'button',
        {
          key: String(o.v),
          type: 'button',
          onClick: () => onChange(o.v),
          style: {
            border: 'none',
            borderRadius: 4,
            padding: '2px 8px',
            fontSize: 10.5,
            cursor: 'pointer',
            background: o.v === value ? 'var(--ui-bg-elevated, var(--ui-bg-secondary))' : 'transparent',
            color: o.v === value ? C.text : C.sub
          }
        },
        o.label
      )
    )
  )

// The editor's routing state, from configFacts() of a config text.
const routingStateOf = (facts, auxOn) => ({
  sort: facts.sort,
  only: facts.only,
  ignore: facts.ignore,
  order: facts.order,
  requireParams: facts.requireParams,
  dataDeny: facts.dataCollection === 'deny',
  allowFallbacks: facts.allowFallbacks,
  zdr: facts.zdr,
  distill: facts.distill,
  quants: facts.quants,
  maxIn: facts.maxIn,
  maxOut: facts.maxOut,
  maxRest: facts.maxRest,
  minTps: facts.minTps,
  tpsRest: facts.tpsRest,
  maxLat: facts.maxLat,
  latRest: facts.latRest,
  aux: !!auxOn
})

// The config as it is right now. Writes build on this, never on the copy loaded with the popover:
// that copy can be minutes old, and writing it back would undo changes made since (2026-10-10:
// a stale Apply silently removed a provider block).
async function freshConfig(profile) {
  const r = await api(profileReq(profile, { path: '/api/config/raw' }))
  const text = r && r.yaml
  if (!text || typeof text !== 'string') throw new Error('could not re-read the config, nothing written')
  return text
}

const RoutingSection = ({ policyOn = true, providerName, rows, since, recording, reachable, endpoints, prices, days, yaml, aux, health, profile, profileLabel, onApplied }) => {
  const facts = useMemo(() => configFacts(yaml), [yaml])
  const [sel, setSel] = useState(null)
  const [draft, setDraft] = useState(null)
  const [preview, setPreview] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const cur = useMemo(() => routingStateOf(facts, aux && aux.enabled), [facts, aux])
  const st = draft || cur
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  const dirty = draft != null && !same(draft, cur)
  const set = patch => {
    const next = { ...st, ...patch }
    setDraft(same(next, cur) ? null : next)
    setPreview(false)
  }
  const uniq = arr => Array.from(new Set(arr.filter(Boolean)))
  const allEps = useMemo(() => Object.values(endpoints || {}).flat(), [endpoints])
  const slugsFor = pred => uniq(allEps.filter(pred).map(e => slugOf(e.tag)))
  const slugForName = name => {
    const hit = allEps.find(e => normName(e.name) === normName(name))
    return hit ? slugOf(hit.tag) : normName(name)
  }
  // what the policy (with any unsaved edits) would no longer allow; certain rules only
  const [hqTick, setHqTick] = useState(0)
  useEffect(() => {
    let live = true
    loadProviderInfo().then(() => live && setHqTick(t => t + 1))
    return () => { live = false }
  }, [])
  const [zdrSet, setZdrSet] = useState(null)
  useEffect(() => {
    if (!st.zdr || zdrSet) return
    let live = true
    loadZdr().then(v => live && setZdrSet(v))
    return () => { live = false }
  }, [st.zdr])
  const capIn = parseFloat(st.maxIn)
  const capOut = parseFloat(st.maxOut)
  const exclusion = (model, prov) => {
    const eps = ((endpoints && endpoints[model]) || []).filter(e => normName(e.name) === normName(prov))
    const ids = new Set(eps.map(e => e.tag).concat(eps.map(e => slugOf(e.tag)), [normName(prov)]))
    if (st.ignore.some(i => ids.has(i))) return 'blocked'
    if (st.only.length && !st.only.some(o => ids.has(o))) return 'not in only'
    if (st.zdr && zdrSet && !zdrSet.has(model + '|' + normName(prov))) return 'not zero-retention'
    if (eps.length && st.quants.length && !eps.some(e => st.quants.includes((e.quant || 'unknown').toLowerCase()))) return 'precision not allowed'
    if (eps.length && (capIn >= 0 || capOut >= 0) && !eps.some(e => (!(capIn >= 0) || e.in <= capIn + 1e-9) && (!(capOut >= 0) || e.out <= capOut + 1e-9))) return 'over price cap'
    return null
  }
  const exclWho = (profileLabel || profile || 'default') + (dirty ? ' after your edits' : '')
  const data = useMemo(
    () => routingData(rows, endpoints, prices, days, policyOn ? exclusion : null, exclWho),
    [rows, endpoints, prices, days, JSON.stringify(st), zdrSet, exclWho, hqTick]
  )
  const blocked = slug => st.ignore.includes(slug)
  const toggleIgnore = slug => set({ ignore: blocked(slug) ? st.ignore.filter(x => x !== slug) : st.ignore.concat([slug]) })
  const topModel = data ? data.topModel : null
  const topEps = (topModel && endpoints && endpoints[topModel]) || []
  const allowed = e =>
    (!st.only.length || st.only.some(o => o === e.tag || o === slugOf(e.tag))) &&
    !st.ignore.some(i => i === e.tag || i === slugOf(e.tag)) &&
    (!st.quants.length || st.quants.includes((e.quant || 'unknown').toLowerCase())) &&
    (!(capIn >= 0) || e.in <= capIn + 1e-9) &&
    (!(capOut >= 0) || e.out <= capOut + 1e-9)
  const cheapestAll = topEps.length ? topEps.slice().sort((a, b) => blendedPrice(a) - blendedPrice(b))[0] : null
  const cheapestOk = topEps.filter(allowed).sort((a, b) => blendedPrice(a) - blendedPrice(b))[0] || null
  const floor = cheapestAll && cheapestOk ? blendedPrice(cheapestOk) / blendedPrice(cheapestAll) : null
  const change = dirty ? buildYamlChange(yaml, { kind: 'provider_routing', value: st }) : null
  const yamlChanged = !!(change && change.diff.length)
  const auxChanged = st.aux !== cur.aux
  const recentDays = days.slice(-2)
  const mwMissing = rows.filter(r => recentDays.includes(r.day)).reduce((a, r) => a + num(r.mw_missing), 0)
  const HEALTH_LABEL = {
    profile_home: 'profile lookup',
    sessions_db: 'session list',
    profile_scope: 'profile sync',
    routing_hook: 'routing rules',
    per_model_routing: 'per-model rules',
    account_usage: 'billing'
  }
  const degraded = (health || []).map(k => HEALTH_LABEL[k] || k)
  const auxDrift = !!(aux && aux.enabled && ((aux.out_of_sync || []).length || (aux.stale || []).length))
  const auxTasks = aux ? aux.tasks.filter(t => t.openrouter).length : 0
  const canApply = yamlChanged || auxChanged
  const syncAux = async enabled => api(profileReq(profile, { path: '/api/plugins/hermetic/aux-routing', method: 'POST', body: { enabled } }))
  const apply = async () => {
    if (!canApply) return
    setBusy(true)
    setErr(null)
    try {
      // Only the fields changed in this edit, laid over the config as it is now, so a rule added
      // elsewhere since the popover loaded survives. Routing first, then the background copy.
      const edited = Object.keys(st).filter(k => k !== 'aux' && !same(st[k], cur[k]))
      let wrote = false
      if (edited.length) {
        const latestYaml = await freshConfig(profile)
        const merged = routingStateOf(configFacts(latestYaml), st.aux)
        for (const k of edited) merged[k] = st[k]
        const fresh = buildYamlChange(latestYaml, { kind: 'provider_routing', value: merged })
        if (fresh && fresh.diff.length) {
          await api(profileReq(profile, { path: '/api/config/raw', method: 'PUT', body: { yaml_text: fresh.yaml } }))
          wrote = true
        }
      }
      if (auxChanged || (st.aux && wrote)) await syncAux(st.aux)
      setDraft(null)
      setPreview(false)
      onApplied()
    } catch (e) {
      setErr((e && e.message) || 'write failed')
    } finally {
      setBusy(false)
    }
  }
  const selName = sel && sel.startsWith('p:') ? sel.slice(2) : null
  const selNode = selName && data ? data.provs.find(p => p.id === sel) || null : null
  const selSlug = selName ? slugForName(selName) : null
  const selEps = selName ? allEps.filter(e => normName(e.name) === normName(selName)) : []
  const selCheapest = selEps.slice().sort((a, b) => blendedPrice(a) - blendedPrice(b))[0] || null
  const selMult = selCheapest && cheapestAll && topEps.some(e => normName(e.name) === normName(selName)) ? blendedPrice(topEps.filter(e => normName(e.name) === normName(selName)).sort((a, b) => blendedPrice(a) - blendedPrice(b))[0]) / blendedPrice(cheapestAll) : null
  const [editing, setEditing] = useState(false)
  const [showDiff, setShowDiff] = useState(false)
  const [pick, setPick] = useState(null)
  const [copied, setCopied] = useState(false)
  const [more, setMore] = useState(null)
  const [othersAll, setOthersAll] = useState(false)
  const OTHERS_ROWS = 5
  const [q, setQ] = useState('')
  // no preview figures in the header; only a status word when there is nothing to show
  const right = data || (!policyOn && !rows.length)
    ? null
    : !reachable
      ? 'backend off'
      : recording
        ? 'recording'
        : null
  const cancel = () => {
    setDraft(null)
    setShowDiff(false)
    setPick(null)
    setEditing(false)
  }
  const applyAndClose = async () => {
    await apply()
    setPick(null)
    setEditing(false)
  }
  const sep = () => el('span', { style: { display: 'inline-block', width: 12 } })
  const T = ({ children, onClick, tone, title, active }) => {
    const btn = el(
      'button',
      {
        type: 'button',
        onClick,
        className: onClick ? 'hover:text-(--ui-text-primary)' : undefined,
        style: {
          background: 'transparent',
          border: 'none',
          padding: 0,
          font: 'inherit',
          fontSize: 11,
          cursor: onClick ? 'pointer' : 'default',
          color: tone === 'bad' ? C.bad : tone === 'ok' ? C.ok : tone === 'accent' ? C.accent : active ? C.text : C.sub
        }
      },
      children
    )
    // native title tooltips do not show inside the popover; the SDK's Tip does
    return title ? el(Tip, { label: title }, btn) : btn
  }
  // quiet outlined button: secondary actions next to the one accent Apply
  const Btn = ({ children, onClick, icon, primary, disabled }) =>
    el(
      'button',
      {
        type: 'button',
        onClick,
        disabled,
        className: primary ? undefined : 'hover:bg-(--ui-bg-tertiary) hover:text-(--ui-text-primary)',
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          height: 22,
          padding: '0 10px',
          borderRadius: 6,
          font: 'inherit',
          fontSize: 11,
          lineHeight: 1,
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.6 : 1,
          border: primary ? 'none' : '1px solid ' + C.stroke,
          background: primary ? C.accent : 'transparent',
          color: primary ? '#fff' : C.sub,
          transition: 'background 120ms, color 120ms'
        }
      },
      icon || null,
      children
    )
  const slidersIcon = el(
    'svg',
    { width: 11, height: 11, viewBox: '0 0 12 12', 'aria-hidden': true, style: { display: 'block' } },
    el('path', { d: 'M1.5 3.5h9M1.5 8.5h9', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }),
    el('circle', { cx: 4, cy: 3.5, r: 1.6, fill: 'var(--ui-bg-secondary, #1a1d26)', stroke: 'currentColor', strokeWidth: 1.2 }),
    el('circle', { cx: 8, cy: 8.5, r: 1.6, fill: 'var(--ui-bg-secondary, #1a1d26)', stroke: 'currentColor', strokeWidth: 1.2 })
  )
  // Vendor names as plain text that wraps inside its column. Commas hug the name; clicking a name
  // removes it (struck through on hover), so nothing hidden takes up space.
  const TextList = ({ items, onRemove, tone, onClear }) =>
    items.length
      ? el(
          'div',
          { style: { display: 'flex', alignItems: 'baseline', columnGap: 0, rowGap: 0, flexWrap: 'wrap' } },
          items.map((x, i) =>
            el(
              'span',
              { key: x, style: { whiteSpace: 'nowrap' } },
              el(
                'button',
                {
                  type: 'button',
                  onClick: () => onRemove(x),
                  title: 'remove ' + x,
                  className: 'hover:line-through',
                  style: { background: 'transparent', border: 'none', padding: 0, font: 'inherit', cursor: 'pointer', color: tone === 'bad' ? C.bad : tone === 'ok' ? C.ok : C.text }
                },
                x
              ),
              i < items.length - 1 ? el('span', { style: { color: C.faint, marginRight: 6 } }, ',') : null
            )
          ),
        )
      : null
  const toneColor = t => (t === 'bad' ? C.bad : t === 'warn' ? C.warn : t === 'ok' ? C.ok : C.dim)
  // label column + value column; everything in the value column wraps inside it
  const Row = ({ label, children, tone, title, labelAction, disabled, disabledTip, key }) => {
    const tip = disabled ? disabledTip : title
    const row = el(
      'div',
      {
        key: tip ? undefined : key,
        'aria-disabled': disabled || undefined,
        style: {
          display: 'grid',
          gridTemplateColumns: '52px minmax(0, 1fr)',
          columnGap: 12,
          alignItems: 'baseline',
          fontSize: 11,
          lineHeight: '20px',
          color: C.sub,
          opacity: disabled ? 0.35 : 1,
          cursor: disabled ? 'not-allowed' : 'auto',
          transition: 'opacity 150ms'
        }
      },
      // clicks are switched off on the contents only, so the row itself still shows its tooltip
      el(
        'div',
        { style: { pointerEvents: disabled ? 'none' : 'auto' } },
        el('span', { style: { color: disabled ? C.dim : toneColor(tone), cursor: title && !disabled ? 'help' : 'inherit' } }, label),
        labelAction ? el('div', null, labelAction) : null
      ),
      el('div', { style: { minWidth: 0, pointerEvents: disabled ? 'none' : 'auto' } }, ...(Array.isArray(children) ? children : [children]))
    )
    return tip ? el(Tip, { key, label: tip }, row) : row
  }
  // the second line under a list: shortcuts on the left, clear pushed to the right
  const Shortcuts = ({ children, onClear, hint }) =>
    el(
      'div',
      { style: { display: 'flex', alignItems: 'baseline', columnGap: 18, rowGap: 0, flexWrap: 'wrap' } },
      children,
      onClear
        ? el(
            'button',
            {
              type: 'button',
              onClick: onClear,
              className: 'hover:text-(--ui-text-secondary)',
              style: { background: 'transparent', border: 'none', padding: 0, font: 'inherit', fontSize: 10, cursor: 'pointer', color: C.faint, transition: 'color 120ms' }
            },
            '× clear'
          )
        : null,
      hint ? el('span', { style: { marginLeft: 'auto', color: C.dim } }, hint) : null
    )
  // Every provider serving the models in view, one entry per OpenRouter slug, with its price relative
  // to the cheapest provider for the top model (blank when it does not serve that model).
  const candidates = useMemo(() => {
    const bySlug = new Map()
    for (const e of allEps) {
      const slug = slugOf(e.tag)
      if (!slug) continue
      const cur = bySlug.get(slug) || { slug, name: e.name, region: regionOf(e.name), mult: null }
      if (cheapestAll && topEps.includes(e)) {
        const m = blendedPrice(e) / blendedPrice(cheapestAll)
        if (cur.mult == null || m < cur.mult) cur.mult = m
      }
      bySlug.set(slug, cur)
    }
    return Array.from(bySlug.values()).sort((a, b) => (a.mult == null) - (b.mult == null) || (a.mult || 0) - (b.mult || 0) || a.name.localeCompare(b.name))
  }, [allEps, topEps, cheapestAll])
  const Picker = ({ field }) => {
    const list = st[field]
    const ql = q.trim().toLowerCase()
    const shown = candidates.filter(c => !ql || c.name.toLowerCase().includes(ql) || c.slug.includes(ql))
    const toggle = slug => {
      const next = list.includes(slug) ? list.filter(x => x !== slug) : list.concat([slug])
      if (field === 'only') {
        // "only" means only: an allow-list makes the block list moot, so it is cleared and the list closes
        set({ only: next, ignore: next.length ? [] : st.ignore })
        setPick(null)
      } else {
        set({ [field]: next })
      }
    }
    return el(
      'div',
      { style: { marginTop: 6, border: '1px solid ' + C.stroke, borderRadius: 6, background: 'var(--ui-bg-tertiary)', padding: 4 } },
      el(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 8, borderBottom: '1px solid ' + C.stroke, padding: '0 6px 0 0' } },
        el('input', {
          autoFocus: true,
          value: q,
          placeholder: 'filter providers',
          onChange: e => setQ(e.target.value),
          onKeyDown: e => {
            if (e.key === 'Escape') { e.stopPropagation(); setPick(null) }
            if (e.key === 'Enter' && shown.length === 1) toggle(shown[0].slug)
          },
          style: { flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none', color: C.text, font: 'inherit', fontSize: 11, padding: '3px 6px 5px' }
        }),
        el(
          'button',
          {
            type: 'button',
            onClick: () => setPick(null),
            title: 'close',
            'aria-label': 'close',
            className: 'hover:text-(--ui-text-primary)',
            style: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: 18, height: 18, padding: 0, border: 'none', borderRadius: 4, background: 'transparent', color: C.dim, cursor: 'pointer' }
          },
          el(
            'svg',
            { width: 10, height: 10, viewBox: '0 0 10 10', 'aria-hidden': true, style: { display: 'block' } },
            el('path', { d: 'M2 2l6 6M8 2l-6 6', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' })
          )
        )
      ),
      el(
        'div',
        { style: { maxHeight: 150, overflowY: 'auto', marginTop: 2 } },
        shown.length
          ? shown.map(c => {
              const on = list.includes(c.slug)
              return el(
                'button',
                {
                  key: c.slug,
                  type: 'button',
                  onClick: () => toggle(c.slug),
                  className: 'hover:bg-(--ui-bg-secondary)',
                  style: { display: 'flex', alignItems: 'center', width: '100%', gap: 8, padding: '3px 6px', border: 'none', borderRadius: 4, background: 'transparent', font: 'inherit', fontSize: 11, cursor: 'pointer', color: on ? (field === 'ignore' ? C.bad : field === 'only' ? C.ok : C.text) : C.sub, textAlign: 'left' }
                },
                el('span', { style: { width: 10, flex: 'none', color: field === 'ignore' ? C.bad : field === 'only' ? C.ok : C.text } }, on ? '✓' : ''),
                el('span', { style: { width: 6, height: 6, borderRadius: '50%', flex: 'none', background: regionColor(c.region) } }),
                el('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, c.name),
                c.mult != null
                  ? el('span', { title: 'price for ' + shortModel(topModel) + ' relative to the cheapest provider', style: { color: c.mult < 1.05 ? C.ok : c.mult >= 2 ? C.dim : C.sub, fontVariantNumeric: 'tabular-nums' } }, c.mult.toFixed(1) + '×')
                  : null
              )
            })
          : el('div', { style: { padding: '4px 6px', color: C.dim, fontSize: 11 } }, 'no match')
      )
    )
  }
  const openPick = field => {
    setQ('')
    setPick(pick === field ? null : field)
  }
  // Region shortcuts for the block list, in the same list style as the provider picker. A region is
  // checked when every provider in it is already blocked; clicking adds or removes all of them.
  const REGION_GROUPS = [
    { id: 'cn', label: 'China', color: regionColor('CN'), pred: e => regionOf(e.name) === 'CN' },
    { id: 'west', label: 'non US/EU', color: C.dim, pred: e => !['US', 'EU'].includes(regionOf(e.name)) },
    { id: 'dec', label: 'decentralised', color: regionColor('DEC'), pred: e => regionOf(e.name) === 'DEC' }
  ]
  const RegionPicker = () =>
    el(
      'div',
      { style: { marginTop: 6, border: '1px solid ' + C.stroke, borderRadius: 6, background: 'var(--ui-bg-tertiary)', padding: 4 } },
      el(
        'div',
        { style: { display: 'flex', alignItems: 'center', padding: '2px 0 2px 6px', borderBottom: '1px solid ' + C.stroke, marginBottom: 2 } },
        el('span', { style: { flex: 1, color: C.dim, fontSize: 11 } }, 'block by region'),
        el(
          'button',
          {
            type: 'button',
            onClick: () => setPick(null),
            title: 'close',
            'aria-label': 'close',
            className: 'hover:text-(--ui-text-primary)',
            style: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: 18, height: 18, padding: 0, border: 'none', borderRadius: 4, background: 'transparent', color: C.dim, cursor: 'pointer' }
          },
          el('svg', { width: 10, height: 10, viewBox: '0 0 10 10', 'aria-hidden': true, style: { display: 'block' } }, el('path', { d: 'M2 2l6 6M8 2l-6 6', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }))
        )
      ),
      REGION_GROUPS.map(g => {
        const slugs = slugsFor(g.pred)
        const on = slugs.length > 0 && slugs.every(x => st.ignore.includes(x))
        return el(
          'button',
          {
            key: g.id,
            type: 'button',
            disabled: !slugs.length,
            onClick: () => set({ ignore: on ? st.ignore.filter(x => !slugs.includes(x)) : uniq(st.ignore.concat(slugs)) }),
            className: 'hover:bg-(--ui-bg-secondary)',
            style: { display: 'flex', alignItems: 'center', width: '100%', gap: 8, padding: '3px 6px', border: 'none', borderRadius: 4, background: 'transparent', font: 'inherit', fontSize: 11, cursor: slugs.length ? 'pointer' : 'default', color: on ? C.bad : C.sub, textAlign: 'left', opacity: slugs.length ? 1 : 0.5 }
          },
          el('span', { style: { width: 10, flex: 'none', color: C.bad } }, on ? '✓' : ''),
          el('span', { style: { width: 6, height: 6, borderRadius: '50%', flex: 'none', background: g.color } }),
          el('span', { style: { flex: 1 } }, g.label),
          el('span', { style: { color: C.dim, fontVariantNumeric: 'tabular-nums' } }, String(slugs.length))
        )
      })
    )
  // ✓/○ text toggle, same look as the require row
  const check = (on, onClick, text, title) =>
    el(T, { key: text, active: on, onClick, title }, el('span', { style: { color: on ? C.ok : C.dim, marginRight: 5 } }, on ? '✓' : '○'), text)
  // a small underlined number field; called directly (not as a component) so it keeps focus while typing
  const numInput = (value, onChange) =>
    el('input', {
      value: value || '',
      inputMode: 'decimal',
      placeholder: '–',
      onChange: e => onChange(e.target.value.replace(/[^0-9.]/g, '')),
      style: { width: 40, margin: '0 4px', background: 'transparent', border: 'none', borderBottom: '1px solid ' + C.stroke, outline: 'none', color: C.text, font: 'inherit', fontSize: 11, textAlign: 'right', fontVariantNumeric: 'tabular-nums', padding: '0 2px' }
    })
  // quantisations offered by the providers of the models in view, plus anything already chosen
  const quantChoices = uniq(
    allEps.map(e => (e.quant || 'unknown').toLowerCase()).concat(st.quants)
  ).sort((a, b) => (a === 'unknown') - (b === 'unknown') || a.localeCompare(b))
  const hasMore = x => x.order.length || !x.allowFallbacks || x.quants.length || x.maxIn || x.maxOut || x.minTps || x.maxLat || x.distill
  const moreOpen = more == null ? !!hasMore(st) : more
  // the routing sections exactly as written in this profile's config.yaml (Policy viewer + copy)
  const rawSection = name => {
    const body = yamlBlock(yaml, name)
    while (body.length && !body[body.length - 1].trim()) body.pop()
    return body.length ? [name + ':'].concat(body).join('\n') : null
  }
  const rawPolicy = [rawSection('provider_routing') || '# provider_routing is not set: OpenRouter defaults apply', rawSection('auxiliary')].filter(Boolean).join('\n\n')
  // always named: these rules belong to one profile, while the costs above cover all of them
  const profileId = profile || 'default'
  const profileName = profileLabel || profileId
  const profileTip = 'These rules apply to ' + profileName + ' only (profile ' + profileId + '). Costs above include all profiles.'
  // One icon per active rule, coloured by effect: good protects you, neutral is a preference,
  // bad can make calls fail. Each explains itself on hover.
  const rules = []
  const rule = (icon, tone, tip) => rules.push({ icon, tone, tip })
  if (cur.sort) rule('price', 'neutral', 'Sort providers by ' + cur.sort + ', a preference')
  if (cur.ignore.length) rule('ban', 'good', cur.ignore.length + ' blocked: ' + cur.ignore.join(', '))
  if (cur.only.length) rule('only', 'bad', 'Only ' + cur.only.join(', ') + '. Calls fail if ' + (cur.only.length === 1 ? 'it is' : 'they are') + ' down')
  if (cur.order.length) rule('order', 'neutral', 'Tried first, in order: ' + cur.order.join(', '))
  if (cur.dataDeny) rule('eyeoff', 'good', 'No data collection: providers may not store or train on your prompts')
  if (cur.zdr) rule('dboff', 'good', 'Zero retention: providers keep nothing after answering')
  if (cur.requireParams) rule('params', 'neutral', 'Only providers that support every request parameter')
  if (cur.quants.length) rule('chip', 'neutral', 'Only these precisions: ' + cur.quants.join(', '))
  if (cur.maxIn || cur.maxOut) rule('cap', 'neutral', 'Price cap per million tokens: in $' + (cur.maxIn || 'any') + ', out $' + (cur.maxOut || 'any'))
  if (cur.minTps || cur.maxLat) rule('speed', 'neutral', 'Prefer ' + [cur.minTps ? 'at least ' + cur.minTps + ' tok/s' : '', cur.maxLat ? 'at most ' + cur.maxLat + ' s wait' : ''].filter(Boolean).join(' and '))
  if (cur.distill) rule('book', 'neutral', 'Only models whose makers allow training on their output')
  if (facts.models) rule('sliders', 'neutral', facts.models + (facts.models === 1 ? ' model has' : ' models have') + ' its own rules in the config')
  if (!cur.allowFallbacks) rule('nofall', 'bad', 'No fallback: calls fail if your preferred providers are down')
  if (cur.aux && !auxDrift) rule('layers', 'good', 'Background tasks follow these rules too')
  const toneColor2 = t => (t === 'good' ? C.ok : t === 'bad' ? C.bad : C.sub)
  const RuleIcon = r =>
    el(
      Tip,
      { key: r.icon, label: r.tip },
      el(
        'span',
        { className: 'hover:bg-(--ui-bg-tertiary)', style: { display: 'inline-flex', padding: 3, borderRadius: 5, color: toneColor2(r.tone), cursor: 'help' } },
        el(
          'svg',
          { width: 13, height: 13, viewBox: '0 0 16 16', 'aria-hidden': true, style: { display: 'block' } },
          (POLICY_ICONS[r.icon] || []).map((d, i) => el('path', { key: i, d, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }))
        )
      )
    )
  // Does the policy cost anything? The cheapest provider it still allows for the top model vs the
  // cheapest overall. Shown only as the colour of the policy label, explained on hover.
  const priceTone =
    floor != null && cheapestOk ? (floor < 1.05 ? 'ok' : floor >= 2 ? 'bad' : 'warn') : topModel && topEps.length && !cheapestOk ? 'bad' : null
  const priceTip =
    floor != null && cheapestOk
      ? floor < 1.05
        ? shortModel(topModel) + ': lowest price. Your policy allows the cheapest provider, ' + cheapestOk.name + '.'
        : shortModel(topModel) + ': ' + floor.toFixed(1) + '× the lowest price. Your policy blocks ' + cheapestAll.name + '; the cheapest one left is ' + cheapestOk.name + '.'
      : priceTone === 'bad'
        ? shortModel(topModel) + ': your policy blocks every provider.'
        : undefined
  return el(
    Section,
    { id: 'routing', title: 'Providers', right },
    data
      ? el(Flow, {
          data,
          scale: 1,
          selected: sel,
          onSelect: id => setSel(id && id.startsWith('p:') && id !== 'p:__other' ? (sel === id ? null : id) : null),
          fmtValue: data.byCalls ? v => Math.round(v) + ' calls' : v => fmtUsd(v) + (data.unpriced ? ' ≈' : '')
        })
      : el(
          'div',
          { style: { fontSize: 11, color: C.faint, padding: '2px 0 6px' } },
          !policyOn && !rows.length
            ? 'Provider routing is recorded for OpenRouter only' + (providerName && providerName !== 'Hermes' ? '; this profile uses ' + providerName : '')
            : !reachable ? 'backend plugin off, restart Hermes' : recording ? 'no calls in this period' : 'waiting for the first call'
        ),
    // the small providers folded into "others": the box opened up, full width so names fit
    data && data.restProvs.length
      ? el(
          'div',
          { style: { marginTop: 6, fontSize: 10.5, lineHeight: '18px', color: C.sub } },
          // two fixed columns so every row starts at the same place; share right-aligned in each cell
          el(
            'div',
            { style: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', columnGap: 24, rowGap: 0 } },
            (othersAll ? data.restProvs : data.restProvs.slice(0, OTHERS_ROWS * 2)).map(p => {
              const row = el(
                'button',
                {
                  key: p.id,
                  type: 'button',
                  onClick: () => setSel(sel === p.id ? null : p.id),
                  className: 'hover:text-(--ui-text-primary)',
                  style: { display: 'flex', alignItems: 'baseline', gap: 5, minWidth: 0, width: '100%', whiteSpace: 'nowrap', background: 'transparent', border: 'none', padding: 0, font: 'inherit', cursor: 'pointer', color: sel === p.id ? C.text : p.excluded ? C.faint : C.sub, textAlign: 'left' }
                },
                el('span', {
                  style: {
                    display: 'inline-block', width: 5, height: 5, borderRadius: '50%', flex: 'none', alignSelf: 'center',
                    background: p.excluded ? 'transparent' : regionColor(p.region),
                    boxShadow: p.excluded ? 'inset 0 0 0 1.2px ' + regionColor(p.region) : 'none',
                    opacity: p.excluded ? 0.7 : 1
                  }
                }),
                el('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', textDecoration: p.excluded ? 'line-through' : 'none' } }, p.name),
                el('span', { style: { color: p.excluded ? C.faint : C.dim, fontVariantNumeric: 'tabular-nums' } }, fmtShare(p.share))
              )
              return el(Tip, { key: p.id, label: p.name + (p.hit != null ? ', ' + fmtHit(p.hit) + ' cached' : '') + (p.note ? ', ' + p.note : '') }, row)
            })
          ),
          data.restProvs.length > OTHERS_ROWS * 2
            ? el(T, { onClick: () => setOthersAll(!othersAll) }, othersAll ? 'show less' : 'show ' + (data.restProvs.length - OTHERS_ROWS * 2) + ' more')
            : null
        )
      : null,
    selNode
      ? el(
          'div',
          { style: { display: 'flex', alignItems: 'baseline', fontSize: 11, lineHeight: '20px', color: C.sub, marginTop: 4, whiteSpace: 'nowrap', overflow: 'hidden' } },
          el('span', { style: { color: C.text } }, selName),
          sep(),
          el('span', { style: { color: regionColor(regionOf(selName)) } }, REGION_LABEL[regionOf(selName)] || regionOf(selName)),
          sep(),
          el('span', { className: 'mono' }, selNode.calls + ' calls'),
          selNode.hit != null ? sep() : null,
          selNode.hit != null ? el(Tip, { label: 'Prompt tokens this provider served from its cache' }, el('span', { style: { color: selNode.hit >= 0.9 ? C.sub : selNode.hit >= 0.75 ? C.warn : C.bad, cursor: 'help' } }, fmtHit(selNode.hit) + ' cached')) : null,
          data.byCalls ? null : sep(),
          data.byCalls ? null : el('span', null, fmtUsd(selNode.value)),
          selMult != null ? sep() : null,
          selMult != null ? el('span', { style: { color: selMult >= 2 ? C.bad : selMult >= 1.3 ? C.warn : C.ok } }, selMult.toFixed(1) + '× floor') : null,
          selCheapest && selCheapest.quant ? sep() : null,
          selCheapest && selCheapest.quant ? el('span', null, selCheapest.quant) : null,
          el('span', { style: { flex: 1 } }),
          policyOn ? el(T, { tone: blocked(selSlug) ? 'ok' : 'bad', onClick: () => { toggleIgnore(selSlug); setEditing(true) } }, blocked(selSlug) ? 'unblock' : 'block') : null,
          policyOn ? sep() : null,
          policyOn ? el(T, { active: st.only.length === 1 && st.only[0] === selSlug, onClick: () => { const on = st.only.length === 1 && st.only[0] === selSlug; set(on ? { only: [] } : { only: [selSlug], ignore: [] }); setEditing(true) } }, 'only') : null
        )
      : null,
    // policy: one quiet line, or the editor; without OpenRouter on this profile only Hermes warnings
    // without OpenRouter: the same line, the provider in place of the rules, and Edit greyed out
    !policyOn
      ? el(
          'div',
          { style: { display: 'flex', alignItems: 'center', fontSize: 11, lineHeight: '20px', color: C.sub, marginTop: 8, paddingTop: 8, borderTop: '1px solid ' + C.stroke } },
          el('span', { style: { color: C.dim, width: 44, flex: 'none' } }, 'policy'),
          el(Tip, { label: profileTip }, el('span', { style: { color: C.dim, marginRight: 10, whiteSpace: 'nowrap', cursor: 'help' } }, profileName)),
          el('span', { style: { color: C.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, providerName && providerName !== 'Hermes' ? 'via ' + providerName : 'not on OpenRouter'),
          degraded.length
            ? el(
                Tip,
                { label: 'A Hermes update changed internals this plugin uses. Fallbacks are running; ' + degraded.join(', ') + ' may be limited.' },
                el('span', { style: { color: C.warn, marginLeft: 12, whiteSpace: 'nowrap', cursor: 'help' } }, 'degraded: ' + degraded.join(', '))
              )
            : null,
          el('span', { style: { flex: 1 } }),
          el(Tip, { label: 'Detailed routing rules (provider order, blocks, sorting, zero retention, fallback) are supported only with OpenRouter.' + (providerName && providerName !== 'Hermes' ? ' This profile uses ' + providerName + '.' : '') },
            el('span', { style: { display: 'inline-flex', cursor: 'not-allowed' } }, el(Btn, { disabled: true, icon: slidersIcon }, 'Edit')))
        )
      : !editing && !dirty
      ? el(
          'div',
          { style: { display: 'flex', alignItems: 'center', fontSize: 11, lineHeight: '20px', color: C.sub, marginTop: 8, paddingTop: 8, borderTop: '1px solid ' + C.stroke } },
          priceTip
            ? el(Tip, { label: priceTip }, el('span', { style: { color: toneColor(priceTone), width: 44, flex: 'none', cursor: 'help' } }, 'policy'))
            : el('span', { style: { color: toneColor(priceTone), width: 44, flex: 'none' } }, 'policy'),
          el(Tip, { label: profileTip }, el('span', { style: { color: C.dim, marginRight: 10, whiteSpace: 'nowrap', cursor: 'help' } }, profileName)),
          rules.length
            ? el('span', { style: { display: 'inline-flex', alignItems: 'center', flexWrap: 'wrap', gap: 2 } }, rules.map(RuleIcon))
            : el('span', { style: { color: C.dim } }, 'default routing'),
          mwMissing > 0
            ? el(
                Tip,
                { label: 'These OpenRouter calls went out without the routing middleware, so zero retention, fallback and the other advanced rules were not sent. Usually a Hermes update changed its request hook.' },
                el('span', { style: { color: C.bad, marginLeft: 12, whiteSpace: 'nowrap', cursor: 'help' } }, 'rules skipped on ' + mwMissing + (mwMissing === 1 ? ' call' : ' calls'))
              )
            : null,
          degraded.length
            ? el(
                Tip,
                { label: 'A Hermes update changed internals this plugin uses. Fallbacks are running; ' + degraded.join(', ') + ' may be limited.' },
                el('span', { style: { color: C.warn, marginLeft: 12, whiteSpace: 'nowrap', cursor: 'help' } }, 'degraded: ' + degraded.join(', '))
              )
            : null,
          auxDrift
            ? el(
                'span',
                { style: { marginLeft: 12, whiteSpace: 'nowrap' } },
                el(T, { tone: 'warn', title: 'Background tasks have older rules than the main agent, or a task left OpenRouter', onClick: async () => { await syncAux(true); onApplied() } }, el('span', { style: { color: C.warn } }, 'background out of date, sync'))
              )
            : null,
          el('span', { style: { flex: 1 } }),
          el(Btn, { onClick: () => setEditing(true), icon: slidersIcon }, 'Edit')
        )
      : el(
          'div',
          { style: { marginTop: 8, paddingTop: 10, borderTop: '1px solid ' + C.stroke, display: 'flex', flexDirection: 'column', gap: 10 } },
          Row({ label: 'profile', title: profileTip, children: el('span', { style: { color: C.text } }, profileName) }),
          el(Row, { label: 'sort' }, el(Seg, { options: SORT_CHOICES, value: st.sort, onChange: v => set({ sort: v }) })),
          Row({
            label: 'block',
            disabled: st.only.length > 0,
            disabledTip: 'not used while only is set',
            tone: priceTone === 'ok' ? null : priceTone,
            title: priceTone === 'ok' ? undefined : priceTip,
            children: [
            el(TextList, { items: st.ignore, tone: 'bad', onRemove: x => set({ ignore: st.ignore.filter(y => y !== x) }) }),
            el(
              Shortcuts,
              { onClear: st.ignore.length ? () => set({ ignore: [] }) : null },
              el(T, { active: pick === 'ignore', onClick: () => openPick('ignore') }, '+ provider'),
              el(T, { active: pick === 'region', onClick: () => openPick('region') }, '+ region')
            ),
            pick === 'ignore' ? Picker({ field: 'ignore' }) : null,
            pick === 'region' ? RegionPicker() : null
            ]
          }),
          Row({
            label: 'only',
            tone: priceTone === 'ok' ? null : priceTone,
            title: priceTone === 'ok' ? undefined : priceTip,
            children: [
            el(TextList, { items: st.only, tone: 'ok', onRemove: x => set({ only: st.only.filter(y => y !== x) }) }),
            el(Shortcuts, { onClear: st.only.length ? () => set({ only: [] }) : null }, el(T, { active: pick === 'only', onClick: () => openPick('only') }, '+ provider')),
            pick === 'only' ? Picker({ field: 'only' }) : null
            ]
          }),
          Row({
            label: 'require',
            children: el(
              'div',
              { style: { display: 'flex', columnGap: 18, rowGap: 0, flexWrap: 'wrap' } },
              check(st.requireParams, () => set({ requireParams: !st.requireParams }), 'all parameters', 'only providers that support every parameter Hermes sends'),
              check(st.dataDeny, () => set({ dataDeny: !st.dataDeny }), 'no data collection', 'skip providers that may store or train on prompts'),
              check(st.zdr, () => set({ zdr: !st.zdr }), 'zero retention', 'only endpoints that keep nothing after answering')
            )
          }),
          aux
            ? Row({
                label: 'scope',
                title: 'Hermes does not apply these rules to its background calls (titles, compression, search, review and more). This copies them there.',
                children: check(st.aux, () => set({ aux: !st.aux }), 'background tasks too')
              })
            : null,
          moreOpen
            ? [
                Row({
                  key: 'order',
                  label: 'order',
                  title: 'Providers OpenRouter tries first, in this order, before anything else',
                  children: [
                    el(TextList, { items: st.order, onRemove: x => set({ order: st.order.filter(y => y !== x) }) }),
                    el(Shortcuts, { onClear: st.order.length ? () => set({ order: [] }) : null }, el(T, { active: pick === 'order', onClick: () => openPick('order') }, '+ provider')),
                    pick === 'order' ? Picker({ field: 'order' }) : null
                  ]
                }),
                Row({
                  key: 'fallback',
                  label: 'fallback',
                  title: 'Whether OpenRouter may switch to other providers when your preferred ones fail',
                  children: check(st.allowFallbacks, () => set({ allowFallbacks: !st.allowFallbacks }), 'other providers')
                }),
                Row({
                  key: 'quant',
                  label: 'quant',
                  title: 'Only use providers running the model at these precisions; none checked allows any',
                  children: el(
                    'div',
                    { style: { display: 'flex', columnGap: 14, rowGap: 0, flexWrap: 'wrap' } },
                    quantChoices.map(q => check(st.quants.includes(q), () => set({ quants: st.quants.includes(q) ? st.quants.filter(x => x !== q) : st.quants.concat([q]) }), q))
                  )
                }),
                Row({
                  key: 'price',
                  label: 'price',
                  title: 'Skip providers charging more than this per million input or output tokens',
                  children: el(
                    'div',
                    { style: { display: 'flex', alignItems: 'baseline', columnGap: 14, flexWrap: 'wrap' } },
                    el('span', null, 'in $', numInput(st.maxIn, v => set({ maxIn: v }))),
                    el('span', null, 'out $', numInput(st.maxOut, v => set({ maxOut: v }))),
                    el('span', { style: { color: C.dim } }, 'per M')
                  )
                }),
                Row({
                  key: 'speed',
                  label: 'speed',
                  title: 'Prefer providers at least this fast; slower ones are tried last, not excluded',
                  children: el(
                    'div',
                    { style: { display: 'flex', alignItems: 'baseline', columnGap: 14, flexWrap: 'wrap' } },
                    el('span', null, 'min ', numInput(st.minTps, v => set({ minTps: v })), ' tok/s'),
                    el('span', null, 'max ', numInput(st.maxLat, v => set({ maxLat: v })), ' s wait')
                  )
                }),
                Row({
                  key: 'model',
                  label: 'model',
                  title: 'Only models whose makers allow training other models on their output',
                  children: check(st.distill, () => set({ distill: !st.distill }), 'distillable only')
                })
              ]
            : null,
          Row({
            label: '',
            children: el(T, { onClick: () => setMore(!moreOpen), title: 'More OpenRouter routing rules: order, fallback, precision, price, speed' }, moreOpen ? 'hide advanced' : 'advanced')
          }),
          el(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, marginTop: 6 } },
            err ? el('span', { style: { color: C.bad } }, err) : null,
            el('span', { style: { flex: 1 } }),
            el(Btn, { onClick: () => setShowDiff(!showDiff) }, dirty ? (showDiff ? 'Hide diff' : 'Diff') : showDiff ? 'Hide policy' : 'Policy'),
            el(Btn, { onClick: cancel }, dirty ? 'Cancel' : 'Done'),
            dirty ? el(Btn, { primary: true, disabled: busy || !canApply, onClick: applyAndClose }, busy ? 'Writing…' : 'Apply') : null
          ),
          showDiff && !dirty
            ? el(
                'div',
                { style: { position: 'relative', marginTop: 6 } },
                el(
                  'div',
                  { style: { background: 'var(--ui-bg-tertiary)', borderRadius: 6, padding: '8px 34px 8px 10px', fontSize: 11, fontFamily: 'var(--font-mono, ui-monospace, monospace)', whiteSpace: 'pre', overflow: 'auto', maxHeight: 260, color: C.sub } },
                  rawPolicy
                ),
                el(
                  Tip,
                  { label: copied ? 'Copied' : 'Copy to clipboard' },
                  el(
                    'button',
                    {
                      type: 'button',
                      'aria-label': 'Copy to clipboard',
                      onClick: async () => {
                        try {
                          await navigator.clipboard.writeText(rawPolicy)
                          setCopied(true)
                          setTimeout(() => setCopied(false), 1500)
                        } catch {
                          /* clipboard unavailable */
                        }
                      },
                      className: 'hover:text-(--ui-text-primary) hover:bg-(--ui-bg-secondary)',
                      style: { position: 'absolute', top: 6, right: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, padding: 0, border: 'none', borderRadius: 5, background: 'transparent', color: copied ? C.ok : C.dim, cursor: 'pointer' }
                    },
                    el(
                      'svg',
                      { width: 13, height: 13, viewBox: '0 0 16 16', 'aria-hidden': true, style: { display: 'block' } },
                      copied
                        ? el('path', { d: 'm3.5 8.5 3 3 6-7', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' })
                        : [
                            el('rect', { key: 'a', x: 5.5, y: 5.5, width: 8, height: 8.5, rx: 1.6, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 }),
                            el('path', { key: 'b', d: 'M10.5 5.5V3.6A1.6 1.6 0 0 0 8.9 2H4.1A1.6 1.6 0 0 0 2.5 3.6v5.8A1.6 1.6 0 0 0 4.1 11h1.4', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' })
                          ]
                    )
                  )
                )
              )
            : null,
          dirty && showDiff && change
            ? el(
                'div',
                { style: { marginTop: 6, background: 'var(--ui-bg-tertiary)', borderRadius: 6, padding: '8px 10px', fontSize: 11 } },
                auxChanged || (st.aux && yamlChanged)
                  ? el(
                      'div',
                      { style: { fontFamily: 'var(--font-mono, ui-monospace, monospace)', color: st.aux ? C.ok : C.bad, marginBottom: yamlChanged ? 6 : 0 } },
                      st.aux ? '+ auxiliary: same rules on ' + auxTasks + ' background tasks' : '- auxiliary: rules removed from background tasks'
                    )
                  : null,
                change.diff.length
                  ? change.diff.map((d, i) =>
                      el(
                        'div',
                        { key: i, style: { fontFamily: 'var(--font-mono, ui-monospace, monospace)', whiteSpace: 'pre-wrap' } },
                        d.from != null ? el('div', { style: { color: C.bad } }, '- ' + d.from.trim()) : null,
                        el('div', { style: { color: C.ok } }, '+ ' + d.to.trim())
                      )
                    )
                  : auxChanged
                    ? null
                    : el('div', { style: { color: C.dim } }, 'no change')
              )
            : null
        )
  )
}

// ---- context gauge: the focused chat's context window fill ------------------

const ContextGauge = ({ pct, used, max, threshold }) => {
  const H = 14
  const W = 6
  const fill = Math.max(0, Math.min(100, pct)) / 100
  const tone = pct >= 90 ? C.bad : pct >= threshold * 100 ? C.warn : C.accent
  return el(
    'span',
    { title: 'context ' + Math.round(pct) + '%' + (used && max ? ', ' + fmtTok(used) + ' of ' + fmtTok(max) : '') + ', auto-compaction set to ' + Math.round(threshold * 100) + '%', style: { display: 'inline-flex' } },
    el(
      'svg',
      { width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, 'aria-hidden': true, style: { display: 'block', flexShrink: 0 } },
      el('rect', { x: 1, y: 0, width: 4, height: H, rx: 2, fill: C.track }),
      el('rect', { x: 1, y: H - Math.max(2, fill * H), width: 4, height: Math.max(2, fill * H), rx: 2, fill: tone }),
      el('rect', { x: 0, y: H - threshold * H - 0.5, width: W, height: 1, fill: C.dim })
    )
  )
}

// ---- chip -------------------------------------------------------------------

const Chip = () => {
  const { loading, error, data, prices, threshold, retries, yaml, profile, profileLabel, refresh, account, cheapest, orProfile, orAny, scope, profileCount, setScope } = useMeterData()
  const defaultModel = useValue(host.state.model) || ''
  const rates = useLive(prices, defaultModel)
  const focusedUsage = useValue(host.state.focusedUsage)
  const focusedSid = useValue(host.state.focusedSessionId)
  const liveFocused = focusedSid && live.get(focusedSid) && live.get(focusedSid).last ? live.get(focusedSid).last.raw : null
  const ctxSrc = (liveFocused && typeof liveFocused.context_percent === 'number' ? liveFocused : focusedUsage) || null
  const ctxPct = ctxSrc && typeof ctxSrc.context_percent === 'number' && ctxSrc.context_percent > 0 ? ctxSrc.context_percent : null
  const [open, setOpen] = useState(false)

  const week = lastNDays(7)
  const spark = data ? week.map(d => (data.daily.get(d) || { cost: 0 }).cost) : week.map(() => 0)
  // the popover's period picker drives the chip too, immediately
  const [period, setChipPeriod] = useState(() => sget('period', '7d'))
  const [view, setView] = useState(() => sget('view', 'costs'))
  const pickView = v => { setView(v); sset('view', v) }
  const spend = periodSpend(data, account, period)
  const avgRate = spend / periodHours(period)
  const liveRate = rates.reduce((a, r) => a + r.rate, 0)
  const tone = liveRate >= 5 ? 'bad' : liveRate >= 1.5 ? 'warn' : null
  const running = rates.length > 0
  // API key quota nearly exhausted: 5% or less of the limit left turns the spark red.
  const quotaLeft = account && account.limit > 0 && account.remaining != null ? account.remaining / account.limit : null
  const quotaLow = quotaLeft != null && quotaLeft <= 0.05

  const label = error ? '-' : running ? fmtRate(liveRate) : fmtUsd(spend)
  const sub = error ? '' : running ? fmtUsd(spend) + (rates.length > 1 ? '\u2003' + rates.length + ' agents' : '') : fmtRate(avgRate)
  const periodName = period === 'today' ? 'today' : period === '7d' ? 'last 7 days' : 'last 30 days'

  return el(
    Popover,
    { open, onOpenChange: setOpen },
    el(
      PopoverTrigger,
      { asChild: true },
      el(
        'button',
        {
          type: 'button',
          title: error ? 'Hermetic: ' + error : loading ? 'Hermetic: loading' : 'Hermetic, ' + periodName + ', ' + fmtUsd(spend) + (account ? '' : backendPatched ? ' (Hermes estimate)' : ' (Hermes estimate, backend plugin off)'),
          className: cn(
            'inline-flex h-full items-center gap-2 px-2 text-[0.6875rem] transition-colors',
            'hover:bg-(--chrome-action-hover)',
            open ? 'bg-(--chrome-action-hover)' : ''
          ),
          style: {
            color: tone === 'bad' ? C.bad : tone === 'warn' ? C.warn : C.sub,
            fontVariantNumeric: 'tabular-nums'
          }
        },
        ctxPct != null ? el(ContextGauge, { pct: ctxPct, used: ctxSrc.context_used, max: ctxSrc.context_max, threshold }) : null,
        el(Spark, { values: spark, tone: quotaLow ? 'bad' : tone, marks: resets.filter(r => r.cause === 'swap') }),
        el('span', { style: { color: tone ? 'inherit' : C.text } }, label),
        sub ? el('span', { style: { color: tone ? 'inherit' : C.dim, opacity: tone ? 0.85 : 1 } }, sub) : null
      )
    ),
    el(
      PopoverContent,
      { align: 'end', sideOffset: 8, variant: 'menu', className: 'w-auto p-0 overflow-hidden' },
      data
        ? el(Body, { meter: data, prices, threshold, retries, yaml, profile, profileLabel, refresh, rates, defaultModel, account, cheapest, orProfile, orAny, onPeriod: setChipPeriod, view, onView: pickView, scope, profileCount, onScope: setScope })
        : el('div', { style: { padding: 16, fontSize: 12, color: C.sub, width: 240 } }, error ? error : 'Loading…')
    )
  )
}

export default {
  id: ID,
  name: 'Hermetic',
  register(ctx) {
    carryOverLegacyStorage()
    store = ctx.storage
    initResets()
    ctx.register({
      id: 'chip',
      area: 'statusBar.right',
      order: 120,
      render: () => el(Chip, {})
    })
  }
}
