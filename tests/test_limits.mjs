// Which OpenRouter limit stops requests first, credits or the key's cap. Run: node tests/test_limits.mjs
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'desktop', 'plugin.js'), 'utf8')
const grabFn = name => { const a = src.indexOf('function ' + name + '('); return src.slice(a, src.indexOf('\n}\n', a) + 2) }
const grabConst = name => { const a = src.indexOf('const ' + name + ' = '); return src.slice(a, src.indexOf('\n}\n', a) + 2) }
const { parseAccountLines, spendLimit } = new Function(
  [src.match(/^const num = .*$/m)[0], grabConst('fmtUsd'), grabConst('money'), grabFn('parseAccountLines'), grabFn('spendLimit')].join('\n') + '\nreturn { parseAccountLines, spendLimit }'
)()

const lines = (left, balance) => ['📈 Account limits', 'Provider: openrouter',
  'API key quota: 15% remaining (85% used) • $' + left + ' of $200.00 remaining',
  'Credits balance: $' + balance, 'API key usage: $170.04 total • $7.52 today • $36.30 this week • $170.04 this month']

const cases = [
  // the day requests were refused: $29.96 left on the key but no credits
  ['credits ran out first', lines('29.96', '0.00'), { by: 'credits', cap: 170.04, left: 0, used: 170.04 }],
  // after a top-up of about $29: credits still a dollar short of the key
  ['credits a dollar short', lines('29.96', '28.96'), { by: 'credits', cap: 199, left: 28.96, used: 170.04 }],
  // plenty of credits: the key's cap is what stops requests
  ['key cap first', lines('29.96', '500.00'), { by: 'key', cap: 200, left: 29.96, used: 170.04 }]
]

let failed = 0
for (const [name, input, want] of cases) {
  const got = spendLimit(parseAccountLines(input))
  const ok = got && got.by === want.by && Math.abs(got.cap - want.cap) < 0.01 && Math.abs(got.left - want.left) < 0.01 && Math.abs(got.used - want.used) < 0.01
  if (!ok) failed++
  console.log(ok ? 'ok  ' : 'FAIL', name, ok ? '' : JSON.stringify(got))
}
const noInfo = spendLimit(null) === null && spendLimit(parseAccountLines(['Provider: openrouter'])) === null
if (!noInfo) failed++
console.log(noInfo ? 'ok  ' : 'FAIL', 'nothing to show without account data')
process.exit(failed ? 1 : 0)
