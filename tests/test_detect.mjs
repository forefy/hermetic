// OpenRouter detection and price lookup from desktop/plugin.js. Run: node tests/test_detect.mjs
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'desktop', 'plugin.js'), 'utf8')
const grab = name => { const a = src.indexOf('function ' + name + '('); return src.slice(a, src.indexOf('\n}\n', a) + 2) }
const { configUsesOpenRouter, configUsesNous, providerLabel } = new Function(
  ['yamlBlock', 'modelKey', 'modelBaseUrl', 'configUsesNous', 'configUsesOpenRouter', 'providerLabel'].map(grab).join('\n') + '\nreturn { configUsesOpenRouter, configUsesNous, providerLabel }'
)()

const cases = [
  ['two spaces', 'model:\n  provider: openrouter\n  default: x', true, 'OpenRouter'],
  ['four spaces', 'model:\n    provider: "openrouter"\n    default: x', true, 'OpenRouter'],
  ['tab', 'model:\n\tprovider: openrouter', true, 'OpenRouter'],
  ['base_url only', 'model:\n  base_url: https://openrouter.ai/api/v1', true, 'OpenRouter'],
  ['inline', 'model: {provider: openrouter, default: x}', true, 'OpenRouter'],
  ['auto', 'model:\n  provider: auto', null, 'Hermes'],
  ['custom endpoint', 'model:\n    provider: custom\n    base_url: https://api.example-llm.ai/v1', false, 'example-llm.ai'],
  ['known provider', 'model:\n  provider: nous\n  base_url: https://inference-api.nousresearch.com/v1', false, 'Nous Portal'],
  ['nested key not read', 'model:\n  extra:\n    provider: openrouter\n  provider: anthropic', false, 'Anthropic'],
  ['no model block', 'other:\n  a: 1', null, 'Hermes'],
  // a provider the config defines itself: its address sits under providers:, not under model:
  ['own provider on Nous', 'model:\n  provider: nous-key\nproviders:\n  nous-key:\n    api: https://inference-api.nousresearch.com/v1\n    models:\n      - a/b\n    base_url: https://inference-api.nousresearch.com/v1', false, 'Nous Portal'],
  ['own provider on OpenRouter', 'model:\n  provider: My-OR\nproviders:\n  other:\n    base_url: https://api.example-llm.ai/v1\n  my-or:\n    base_url: "https://openrouter.ai/api/v1"', true, 'OpenRouter'],
  ["another provider's address not read", 'model:\n  provider: mine\nproviders:\n  mine:\n    name: mine\n  other:\n    base_url: https://openrouter.ai/api/v1', false, 'mine']
]
const nousCases = [
  ['provider nous', 'model:\n  provider: nous', true],
  ['own provider on Nous', 'model:\n  provider: nous-key\nproviders:\n  nous-key:\n    base_url: https://inference-api.nousresearch.com/v1', true],
  ['own provider elsewhere', 'model:\n  provider: mine\nproviders:\n  mine:\n    base_url: https://api.example-llm.ai/v1', false],
  ['openrouter', 'model:\n  provider: openrouter', false]
]
// price lookup: a custom endpoint's model name finds the same model on OpenRouter's list
const grabConst = name => { const a = src.indexOf('const ' + name + ' = '); return src.slice(a, src.indexOf('\n}\n', a) + 2) }
const priceIdOf = new Function('let priceTail = null\nlet priceTailOf = null\n' + grabConst('priceIdOf') + '\nreturn priceIdOf')()
const prices = { 'deepseek/deepseek-v4-pro': {}, 'z-ai/glm-5.3': {} }
const priceCases = [
  ['exact id', 'z-ai/glm-5.3', 'z-ai/glm-5.3'],
  ['other vendor and casing', 'deepinfra/DeepSeek-V4-Pro', 'deepseek/deepseek-v4-pro'],
  ['unknown model', 'acme/secret-model', null],
  ['no model', '', null]
]

let failed = 0
for (const [name, model, want] of priceCases) {
  const got = priceIdOf(prices, model)
  if (got !== want) failed++
  console.log(got === want ? 'ok  ' : 'FAIL', 'price: ' + name, got === want ? '' : JSON.stringify(got))
}
for (const [name, yaml, uses, label] of cases) {
  const got = [configUsesOpenRouter(yaml), providerLabel(yaml)]
  const ok = got[0] === uses && got[1] === label
  if (!ok) failed++
  console.log(ok ? 'ok  ' : 'FAIL', name, ok ? '' : JSON.stringify(got))
}
for (const [name, yaml, want] of nousCases) {
  const got = configUsesNous(yaml)
  if (got !== want) failed++
  console.log(got === want ? 'ok  ' : 'FAIL', 'nous: ' + name, got === want ? '' : JSON.stringify(got))
}
process.exit(failed ? 1 : 0)
