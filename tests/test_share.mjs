// One profile's part of the OpenRouter bill when several profiles share the key. Run: node tests/test_share.mjs
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'desktop', 'plugin.js'), 'utf8')
const grabConst = name => { const a = src.indexOf('const ' + name + ' = '); return src.slice(a, src.indexOf('\n}\n', a) + 2) }
const line = re => src.match(re)[0]
const { keyShare, periodSpend, lastNDays } = new Function(
  [line(/^const num = .*$/m), line(/^const DEFAULT_DAYS = .*$/m), line(/^const dateStr = d =>\n.*$/m),
    grabConst('accountWindowStart'), grabConst('lastNDays'), grabConst('keyShare'), grabConst('periodSpend')].join('\n') +
    '\nreturn { keyShare, periodSpend, lastNDays }'
)()

const days = lastNDays(7)
const today = days[6]
const map = rows => new Map(rows.map(([day, cost]) => [day, { day, cost }]))
const account = { today: 19.94, week: 60, month: 180 }

const cases = [
  // the screenshot: a week-old chat still running books nothing today, but this profile is the only
  // one on the key, so it gets the whole bill
  ['only profile on the key, chat started days ago', () =>
    periodSpend({ daily: map([[days[0], 67], [today, 1.49]]), orDaily: map([[days[0], 67], [today, 1.49]]) }, account, 'today', 'profile'), 19.94],
  // two profiles that each spent half over the week split today's bill, whatever today's list cost says
  ['half the key over 7 days', () =>
    periodSpend({ daily: map([[days[2], 10], [today, 0.1]]), orDaily: map([[days[2], 10], [days[3], 10], [today, 5]]) }, account, 'today', 'profile'),
    19.94 * (10.1 / 25)],
  // all profiles: the bill as it is
  ['all profiles', () => periodSpend({ daily: map([[today, 1]]), orDaily: null }, account, 'today', 'all'), 19.94],
  // nobody has list cost in the window: fall back to the profile's own estimate
  ['no list cost anywhere', () => periodSpend({ daily: map([]), orDaily: map([]) }, account, 'today', 'profile'), 0],
  // no other profile on the key (no orDaily): the whole bill
  ['no shared key', () => keyShare({ daily: map([[today, 2]]), orDaily: null }, 'today'), 1],
  // a share never exceeds the bill
  ['capped at the bill', () => keyShare({ daily: map([[today, 9]]), orDaily: map([[today, 3]]) }, 'today'), 1]
]

let failed = 0
for (const [name, run, want] of cases) {
  const got = run()
  const ok = Math.abs(got - want) < 0.01
  if (!ok) failed++
  console.log(ok ? 'ok  ' : 'FAIL', name, ok ? '' : 'got ' + got + ', want ' + want)
}
process.exit(failed ? 1 : 0)
