// Days Hermes stored at $0 are priced at list price, once. Run: node tests/test_unpriced_days.mjs
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'desktop', 'plugin.js'), 'utf8')
const grabFn = name => { const a = src.indexOf('async function ' + name + '('); return src.slice(a, src.indexOf('\n}\n', a) + 2) }
const PRICES = { 'z-ai/glm-5.3': { in: 0.1, out: 0.4, cache: 0.02 }, 'openai/gpt-5.5': { in: 1.25, out: 10, cache: 0.125 }, 'demo/tiny:free': { in: 0, out: 0, cache: 0 } }
const load = usage => new Function('usage', 'PRICES', [
  "const OWN = ''", 'const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0 }',
  'const api = async () => usage', 'const loadVendorPrices = async () => {}',
  'const priceOf = (prices, model) => prices[model] || null', "const priceSource = (prices, model) => 'list price of ' + model",
  src.match(/^const costAt = .*\n.*$/m)[0], grabFn('loadAnalytics'),
  "return loadAnalytics([{ name: 'default', isDefault: true }], 7, PRICES)"].join('\n'))(usage, PRICES)

let failed = 0
const check = (name, ok, got) => { if (!ok) failed++; console.log(ok ? 'ok  ' : 'FAIL', name, ok ? '' : JSON.stringify(got)) }
const near = (a, b) => Math.abs(a - b) < 1e-9
const GPT = { input_tokens: 1e6, output_tokens: 1e5, cache_read_tokens: 4e6 } // 1.25 + 1.00 + 0.50 = $2.75 at list
const paidDay = { day: 'd1', estimated_cost: 2, input_tokens: 2e7, output_tokens: 0, cache_read_tokens: 0 }
const paidModel = { model: 'z-ai/glm-5.3', input_tokens: 2e7, output_tokens: 0, cache_read_tokens: 0, estimated_cost: 2 }
const freeDay = model => Object.assign({ day: 'd2', estimated_cost: 0, unpriced: { [model]: GPT } }, GPT)

{
  const r = await load({ daily: [paidDay, freeDay('openai/gpt-5.5')], by_model: [paidModel, Object.assign({ model: 'openai/gpt-5.5', estimated_cost: 0 }, GPT)] })
  check('a $0 day gets its list price', near(r.daily.get('d2').cost, 2.75), r.daily.get('d2'))
  check('a day with a stored cost is left alone', near(r.daily.get('d1').cost, 2), r.daily.get('d1'))
  check('the total follows', near(r.total, 4.75), r.total)
  check('the model is named as estimated', r.estimated.has('openai/gpt-5.5') && !r.unpriced, [...r.estimated.keys()])
}
{
  const r = await load({ daily: [paidDay, freeDay('local/mystery-7b')], by_model: [paidModel, Object.assign({ model: 'local/mystery-7b', estimated_cost: 0 }, GPT)] })
  check('a model with no list price stays unknown, not $0', near(r.daily.get('d2').cost, 0) && r.unpriced && !r.estimated.size, { cost: r.daily.get('d2').cost, unpriced: r.unpriced })
}
{
  // no stored cost anywhere: the whole profile is blended at list price, and the $0 tokens are not added on top
  const r = await load({ daily: [Object.assign({}, freeDay('openai/gpt-5.5'), { day: 'd1' }), freeDay('openai/gpt-5.5')], by_model: [{ model: 'openai/gpt-5.5', estimated_cost: 0, input_tokens: 2e6, output_tokens: 2e5, cache_read_tokens: 8e6 }] })
  check('a blended profile is priced once', near(r.daily.get('d1').cost, 2.75) && near(r.daily.get('d2').cost, 2.75) && near(r.total, 5.5), r.total)
}
{
  const r = await load({ daily: [paidDay, freeDay('demo/tiny:free')], by_model: [paidModel, Object.assign({ model: 'demo/tiny:free', estimated_cost: 0 }, GPT)] })
  check('a free model adds nothing', near(r.daily.get('d2').cost, 0) && near(r.total, 2), r.total)
  check('a free model is not called an estimate', !r.estimated.size && !r.unpriced, [...r.estimated.keys()])
}
process.exit(failed ? 1 : 0)
