// Whether Hermes' proactive prune pays for a profile, and the config change that turns it on.
// Run: node tests/test_prune.mjs
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'desktop', 'plugin.js'), 'utf8')
const grabFn = name => { const a = src.indexOf('function ' + name + '('); return src.slice(a, src.indexOf('\n}\n', a) + 2) }
const { servedRates, compressionValue, buildYamlChange } = new Function(
  [src.match(/^const num = .*$/m)[0], grabFn('servedRates'), grabFn('compressionValue'), grabFn('buildYamlChange')].join('\n') +
    '\nreturn { servedRates, compressionValue, buildYamlChange }'
)()

let failed = 0
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  console.log(ok ? 'ok  ' : 'FAIL', name, ok ? '' : 'got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want))
}

// a model served 3:1 by a provider with a 10x cache discount and one with none
const data = {
  routing: { rows: [{ model: 'z-ai/glm-5.3', upstream: 'Mistral', input: 100, cache: 2900 }, { model: 'z-ai/glm-5.3', upstream: 'Wafer', input: 1000, cache: 0 }] },
  endpoints: { 'z-ai/glm-5.3': [{ name: 'Mistral', in: 1.4, cache: 0.14 }, { name: 'Wafer', in: 0.079, cache: 0.078 }] }
}
const r = servedRates(data).get('z-ai/glm-5.3')
check('weighted by the prompt tokens each provider took', [r.in.toFixed(4), r.cache.toFixed(4)], [(0.75 * 1.4 + 0.25 * 0.079).toFixed(4), (0.75 * 0.14 + 0.25 * 0.078).toFixed(4)])
check('no record, no served rate', servedRates({ routing: { rows: [] }, endpoints: {} }).size, 0)

check('prune setting read from config', compressionValue('compression:\n  threshold: 0.5\n  proactive_prune_tokens: 48000\n', 'proactive_prune_tokens'), 48000)
check('unset is null', compressionValue('compression:\n  threshold: 0.5\n', 'proactive_prune_tokens'), null)
const ch = { kind: 'compression', key: 'proactive_prune_tokens', value: '48000' }
check('added under compression', buildYamlChange('model:\n  default: x\ncompression:\n  threshold: 0.5\n', ch).yaml, 'model:\n  default: x\ncompression:\n  proactive_prune_tokens: 48000\n  threshold: 0.5\n')
check('an existing 0 is replaced', buildYamlChange('compression:\n  proactive_prune_tokens: 0  # off\n', ch).yaml, 'compression:\n  proactive_prune_tokens: 48000  # off\n')
check('no compression block yet', buildYamlChange('model:\n  default: x', ch).yaml, 'model:\n  default: x\n\ncompression:\n  proactive_prune_tokens: 48000')
process.exit(failed ? 1 : 0)
