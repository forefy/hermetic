// Matching a provider's model id to an OpenRouter list price. Run: node tests/test_prices.mjs
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'desktop', 'plugin.js'), 'utf8')
const grabConst = name => { const a = src.indexOf('const ' + name + ' = '); return src.slice(a, src.indexOf('\n}\n', a) + 2) }
const { priceIdOf } = new Function(['let priceTail = null', 'let priceTailOf = null', grabConst('priceIdOf')].join('\n') + '\nreturn { priceIdOf }')()

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
for (const [name, model, want] of cases) {
  const got = priceIdOf(prices, model)
  const ok = got === want
  if (!ok) failed++
  console.log(ok ? 'ok  ' : 'FAIL', name, ok ? '' : 'got ' + got + ', want ' + want)
}
process.exit(failed ? 1 : 0)
