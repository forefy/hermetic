// Which OpenRouter limit stops requests first: credits, the key's cap or a workspace budget. Run: node tests/test_limits.mjs
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'desktop', 'plugin.js'), 'utf8')
const grabFn = name => { const a = src.indexOf('function ' + name + '('); return src.slice(a, src.indexOf('\n}\n', a) + 2) }
const grabConst = name => { const a = src.indexOf('const ' + name + ' = '); return src.slice(a, src.indexOf('\n}\n', a) + 2) }
const { parseAccountLines, spendLimit } = new Function(
  [src.match(/^const num = .*$/m)[0], src.match(/^const PERIOD_RESET = .*$/m)[0], grabConst('fmtUsd'), grabConst('money'), grabConst('fmtReset'), grabConst('billOf'), grabConst('nextReset'), grabConst('limitDays'), src.match(/^const limitTone = .*$/m)[0], grabFn('parseAccountLines'), grabFn('spendLimit')].join('\n') + '\nreturn { parseAccountLines, spendLimit }'
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
// a workspace's daily budget with $3 left stops requests before $500 of credits
const daily = { label: 'Workspace daily budget', interval: 'daily', limit: 50, spent: 47, reset_at: new Date(Date.now() + 5 * 3600e3).toISOString() }
const monthly = { label: 'Workspace monthly budget', interval: 'monthly', limit: 300, spent: 47, reset_at: null }
const withBudgets = budgets => Object.assign(parseAccountLines(lines('29.96', '500.00')), { budgets })
const b = spendLimit(withBudgets([monthly, daily]))
const budgetOk = b.by === 'budget' && b.interval === 'daily' && b.cap === 50 && Math.abs(b.left - 3) < 1e-9 && Math.abs(b.share - 0.06) < 1e-9 &&
  b.tip.split('\n')[0] === 'Workspace daily budget $3.00 left of $50, resets in 5h' && b.tip.split('\n').length === 4 && !/days at/.test(b.tip.split('\n')[0])
if (!budgetOk) failed++
console.log(budgetOk ? 'ok  ' : 'FAIL', 'a workspace budget first', budgetOk ? '' : JSON.stringify(b))
// an overspent budget counts as nothing left, and its share warns even when it is not the tightest in dollars
const over = spendLimit(withBudgets([{ ...daily, spent: 52 }]))
const overOk = over.by === 'budget' && over.share === 0 && over.worst === 'bad' && /\$0 left of \$50/.test(over.tip)
if (!overOk) failed++
console.log(overOk ? 'ok  ' : 'FAIL', 'an overspent budget', overOk ? '' : JSON.stringify(over))
const small = spendLimit(withBudgets([{ label: 'Key weekly budget', interval: 'weekly', limit: 10, spent: 9.7, reset_at: null }, { ...monthly, spent: 0 }]))
const lowOk = small.by === 'budget' && small.worst === 'bad'
if (!lowOk) failed++
console.log(lowOk ? 'ok  ' : 'FAIL', 'the chip warns on the budget nearest its limit', lowOk ? '' : JSON.stringify(small))
// the view's period picks the limit that resets on it, else whichever stops requests first, and
// total picks among what never resets
const keyMonthly = Object.assign(parseAccountLines(['Provider: openrouter', 'API key quota: 85% used • $29.96 of $200.00 remaining • resets monthly',
  'Credits balance: $500.00', 'API key usage: $170.04 total']), { budgets: [daily, monthly] })
const onlyBudgets = Object.assign(parseAccountLines(['Provider: openrouter']), { budgets: [daily, monthly] })
const byPeriod = [
  ['today shows the daily budget', withBudgets([monthly, daily]), 'today', false, { by: 'budget', interval: 'daily', canTotal: true }],
  ['30d shows the monthly budget', withBudgets([monthly, daily]), '30d', false, { by: 'budget', interval: 'monthly' }],
  ['7d without a weekly limit shows the one nearest to stopping requests', withBudgets([monthly, daily]), '7d', false, { by: 'budget', interval: 'daily' }],
  ['a key cap that resets monthly counts as the monthly limit', keyMonthly, '30d', false, { by: 'key', interval: 'monthly' }],
  ['total: the credits when they run out before the key cap', withBudgets([monthly, daily]), '7d', true, { by: 'key', interval: null }],
  ['total: credits, a monthly key cap is not total', keyMonthly, 'today', true, { by: 'credits' }],
  ['total with nothing that lasts keeps the period view', onlyBudgets, '7d', true, { by: 'budget', interval: 'daily', canTotal: false }]
]
for (const [name, a, period, total, want] of byPeriod) {
  const got = spendLimit(a, period, total)
  const ok = got && got.by === want.by && (want.interval === undefined || (got.interval || null) === want.interval) &&
    (want.canTotal === undefined || got.canTotal === want.canTotal) && got.worst === spendLimit(a).worst
  if (!ok) failed++
  console.log(ok ? 'ok  ' : 'FAIL', name, ok ? '' : JSON.stringify(got))
}
const noInfo = spendLimit(null) === null && spendLimit(parseAccountLines(['Provider: openrouter'])) === null
if (!noInfo) failed++
console.log(noInfo ? 'ok  ' : 'FAIL', 'nothing to show without account data')
// Color says how soon requests stop at the recent pace, and the limit closest to stopping them takes the line
const soon = (name, ok, got) => { if (!ok) failed++; console.log(ok ? 'ok  ' : 'FAIL', name, ok ? '' : JSON.stringify(got)) }
const inDays = d => new Date(Date.now() + d * 86400e3).toISOString()
const account = (balance, budgets) => Object.assign(parseAccountLines(['Provider: openrouter', 'Credits balance: $' + balance,
  'API key usage: $566.75 total • $12.20 today • $40.95 this week • $249.40 this month']), { budgets })
// the screenshot: $85 of credits after $566 spent, about a week of spending, is no warning
const credits = spendLimit(account('85.56', []), 'today', true)
soon('plenty of credits after a lot spent is no warning', credits.by === 'credits' && credits.tone === null && credits.worst === null, credits)
soon('and the tooltip says how long they last', /about 7 days at the recent pace/.test(credits.tip), credits.tip)
soon('the bar weighs the credits against what the period on screen spent', Math.abs(credits.used - 12.2) < 1e-9 && Math.abs(credits.cap - 97.76) < 1e-9 &&
  Math.abs(spendLimit(account('85.56', []), '7d', true).used - 40.95) < 1e-9 && Math.abs(spendLimit(account('85.56', []), '30d', true).used - 249.4) < 1e-9, credits)
// what was behind the red chip: a monthly budget with $13.91 left and two weeks to its reset
const monthlyNear = { label: 'Workspace monthly budget', interval: 'monthly', limit: 300, spent: 286.09, reset_at: inDays(14) }
const dailyFine = { label: 'Workspace daily budget', interval: 'daily', limit: 120, spent: 19.58, reset_at: inDays(0.5) }
const near = spendLimit(account('85.56', [dailyFine, monthlyNear]), 'today', true)
soon('the budget about to stop requests takes the line, whatever the view', near.by === 'budget' && near.interval === 'monthly' && near.tone === 'warn' && near.worst === 'warn', near)
soon('a budget that resets before it runs out is not the one', spendLimit(account('85.56', [dailyFine]), 'today').tone === null)
soon('a day or less left is red', spendLimit(account('85.56', [{ ...monthlyNear, spent: 290 }]), 'today').worst === 'bad')
soon('nothing left is red', spendLimit(account('0.00', []), '30d').tone === 'bad')
soon('no spending, no hurry', spendLimit(Object.assign(parseAccountLines(['Provider: openrouter', 'Credits balance: $1.00', 'API key usage: $10.00 total • $0.00 today • $0.00 this week']), { budgets: [] }), 'today').tone === null)
soon('a reset more than a week out is named by its date, not a weekday', /resets [A-Z][a-z]{2} \d{1,2}\b/.test(near.tip.split('\n')[0]) && !/resets (Mon|Tue|Wed|Thu|Fri|Sat|Sun)/.test(near.tip.split('\n')[0]), near.tip)
process.exit(failed ? 1 : 0)
