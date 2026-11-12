// A session's cost counted only for the days of the selected period. Run: node tests/test_period_share.mjs
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'desktop', 'plugin.js'), 'utf8')
const grabConst = name => { const a = src.indexOf('const ' + name + ' = '); return a < 0 ? '' : src.slice(a, src.indexOf('\n}\n', a) + 2) }
const { periodShare } = new Function('const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0 }\n' + grabConst('periodShare') + '\nreturn { periodShare }')()

let failed = 0
const check = (name, got, want) => {
  const ok = Math.abs(got - want) < 1e-9
  if (!ok) failed++
  console.log(ok ? 'ok  ' : 'FAIL', name, ok ? '' : 'got ' + got + ', want ' + want)
}
const long = { byDay: { '2026-11-05': 0.5, '2026-11-08': 0.25, '2026-11-11': 0.25 } }
check('today gets only its quarter', periodShare(long, ['2026-11-11']), 0.25)
check('the week gets the days inside it', periodShare(long, ['2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11']), 0.5)
check('a day it never ran on gets nothing', periodShare(long, ['2026-11-09']), 0)
check('the whole span gets all of it', periodShare(long, ['2026-11-05', '2026-11-08', '2026-11-11']), 1)
check('an older backend (no split) counts the whole session', periodShare({}, ['2026-11-11']), 1)
process.exit(failed ? 1 : 0)
