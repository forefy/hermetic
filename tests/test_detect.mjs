// OpenRouter detection and price lookup from desktop/plugin.js. Run: node tests/test_detect.mjs
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'desktop', 'plugin.js'), 'utf8')
const grab = name => { const a = src.indexOf('function ' + name + '('); return src.slice(a, src.indexOf('\n}\n', a) + 2) }
const { configUsesOpenRouter, providerLabel } = new Function(
  ['yamlBlock', 'modelKey', 'configUsesOpenRouter', 'providerLabel'].map(grab).join('\n') + '\nreturn { configUsesOpenRouter, providerLabel }'
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
  ['no model block', 'other:\n  a: 1', null, 'Hermes']
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
process.exit(failed ? 1 : 0)
