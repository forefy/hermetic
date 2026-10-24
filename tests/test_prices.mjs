// Matching a provider's model id to an OpenRouter list price. Run: node tests/test_prices.mjs
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'desktop', 'plugin.js'), 'utf8')
const grabConst = name => { const a = src.indexOf('const ' + name + ' = '); return src.slice(a, src.indexOf('\n}\n', a) + 2) }
const grabFn = name => { const a = src.indexOf('async function ' + name + '('); return src.slice(a, src.indexOf('\n}\n', a) + 2) }
const line = re => src.match(re)[0]
// loadEndpoints stands in for OpenRouter's per-provider endpoint list
const ENDPOINTS = { 'z-ai/glm-5.3': [
  { tag: 'wafer/fp4', name: 'Wafer', in: 0.079, out: 1.4, cache: 0.078 },
  { tag: 'fireworks', name: 'Fireworks', in: 2.1, out: 6.6, cache: 0.39 },
  { tag: 'fireworks/turbo', name: 'Fireworks', in: 0.98, out: 3.08, cache: 0.182 },
  { tag: 'z-ai/fp8', name: 'Z.AI', in: 1.4, out: 4.4, cache: 0.26 }
] }
const { priceIdOf, priceOf, loadVendorPrices } = new Function('ENDPOINTS',
  ['let priceTail = null', 'let priceTailOf = null', 'const loadEndpoints = async ids => Object.fromEntries(ids.map(id => [id, ENDPOINTS[id] || []]))',
    grabConst('priceIdOf'), line(/^const vendorPrice = .*$/m), line(/^const providerKey = .*$/m), grabConst('vendorOf'), grabFn('loadVendorPrices'),
    grabConst('priceOf')].join('\n') + '\nreturn { priceIdOf, priceOf, loadVendorPrices }'
)(ENDPOINTS)

const prices = { 'z-ai/glm-5.3': {}, 'z-ai/glm-5.3:batch': {}, 'anthropic/claude-fable-5': {}, 'qwen/qwen3-235b-a22b': {} }
const cases = [
  ['exact id', 'z-ai/glm-5.3', 'z-ai/glm-5.3'],
  ['other vendor prefix', 'fireworks-ai/glm-5.3', 'z-ai/glm-5.3'],
  // Fireworks writes the version dot as a p
  ['Fireworks p for the dot', 'fireworks-ai/glm-5p3', 'z-ai/glm-5.3'],
  ['Fireworks account path', 'accounts/fireworks/models/glm-5p3', 'z-ai/glm-5.3'],
  // a p between letters and digits is part of the name, not a dot
  ['p inside a name stays', 'qwen/qwen3-235b-a22b', 'qwen/qwen3-235b-a22b'],
  ['unknown model', 'acme/mystery-1p0', null]
]

let failed = 0
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  console.log(ok ? 'ok  ' : 'FAIL', name, ok ? '' : 'got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want))
}
for (const [name, model, want] of cases) check(name, priceIdOf(prices, model), want)

// list prices are the cheapest provider's; a model named after its provider gets that provider's price
const list = { 'z-ai/glm-5.3': { in: 0.079, out: 1.4, cache: 0.078 }, 'anthropic/claude-fable-5': { in: 3, out: 15, cache: 0.3 } }
await loadVendorPrices(['fireworks-ai/glm-5p3', 'z-ai/glm-5.3', 'acme-cloud/glm-5.3', 'anthropic/claude-fable-5'], list)
check('the provider named in the id, its cheapest endpoint', priceOf(list, 'fireworks-ai/glm-5p3'), { in: 0.98, out: 3.08, cache: 0.182, via: 'Fireworks' })
check('the model\'s own vendor keeps the list price', priceOf(list, 'z-ai/glm-5.3'), list['z-ai/glm-5.3'])
check('a provider OpenRouter does not list keeps the list price', priceOf(list, 'acme-cloud/glm-5.3'), list['z-ai/glm-5.3'])
check('same vendor, no endpoint lookup', priceOf(list, 'anthropic/claude-fable-5'), list['anthropic/claude-fable-5'])
process.exit(failed ? 1 : 0)
