// The key's bill stands for a period only when the chats on record reach back to the start of its
// billing window. Run: node tests/test_bill_window.mjs
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'desktop', 'plugin.js'), 'utf8')
const grab = (from, to) => {
  const a = src.indexOf(from)
  const b = src.indexOf(to, a)
  if (a < 0 || b < 0) throw new Error('plugin.js no longer has: ' + (a < 0 ? from : to))
  return src.slice(a, b)
}
const fns = new Function(src.match(/^const DEFAULT_DAYS = .*$/m)[0] + '\n' + grab('const num = ', 'const fmtUsd = ') + grab('const dateStr = ', 'const dayLabel = ') + grab('const accountWindowStart = ', 'const lastNDays = ') +
  grab('const lastNDays = ', 'const dayStart = ') + grab('const keyShare = ', '// ---- data hook') + '\nreturn { periodBill, periodSpend, accountWindowStart, dateStr }')()
const { periodBill, periodSpend, accountWindowStart, dateStr } = fns

let failed = 0
const check = (name, ok, detail) => {
  if (!ok) failed++
  console.log(ok ? 'ok  ' : 'FAIL', name, ok ? '' : detail || '')
}
const daysBefore = (day, n) => { const d = new Date(day + 'T12:00:00'); d.setDate(d.getDate() - n); return d.getTime() / 1000 }
const account = { today: 1.21, week: 1.21, month: 29.01 }
const monthStart = accountWindowStart('30d')
const today = dateStr(new Date())
const chats = started => ({ sessions: [{ started }, { started: Date.now() / 1000 }], daily: new Map([[today, { cost: 1.14 }]]) })

const newMachine = chats(Date.now() / 1000 - 3600) // first chat an hour ago
check('a machine whose chats start after the month began does not take the month\'s bill as its own', periodBill(account, '30d', newMachine) !== 29.01 || monthStart === today)
check('its 30 days show the bill since its chats began (today\'s, as it was set up today)', Math.abs(periodSpend(newMachine, account, '30d', 'all') - 1.21) < 1e-9 || monthStart === today, String(periodSpend(newMachine, account, '30d', 'all')))
check('today\'s bill is its own', periodBill(account, 'today', newMachine) === 1.21)
const oldMachine = chats(daysBefore(monthStart, 3))
check('a machine with chats from before the month uses the month\'s bill', periodBill(account, '30d', oldMachine) === 29.01 && periodSpend(oldMachine, account, '30d', 'all') === 29.01)
check('the week the same way', periodBill(account, '7d', chats(daysBefore(accountWindowStart('7d'), 1))) === 1.21)
check('no chats on record, no bill to compare', periodBill(account, '30d', { sessions: [] }) === null)
check('a machine shown from Hermes\' chat list (a bot\'s own chat left out) keeps each window\'s bill', periodBill(account, '30d', { sessions: [], partial: true }) === 29.01 && periodBill(account, '7d', { sessions: [], partial: true }) === 1.21)
check('and its period spend is that bill', periodSpend({ sessions: [], partial: true, daily: new Map() }, account, '30d', 'all') === 29.01)
check('no account, no bill', periodBill(null, '30d', oldMachine) === null && periodBill({ month: null }, '30d', oldMachine) === null)
// a machine whose chats began inside the month: 30 days is never less than 7
const weekStart = accountWindowStart('7d')
const thisWeek = { sessions: [{ started: Date.parse(weekStart + 'T12:00:00') / 1000 + 86400 * 0 }], daily: new Map([[today, { cost: 1.14 }]]) }
const accountThisWeek = { today: 1.45, week: 10.82, month: 38.62 }
const month = periodBill(accountThisWeek, '30d', thisWeek), week = periodBill(accountThisWeek, '7d', thisWeek)
check('a machine set up this week shows the week bill for 30 days too, never less than for 7', (monthStart > weekStart || month === week) && month >= week, JSON.stringify({ month, week, monthStart, weekStart }))
// set up earlier this month: the week bill plus the list cost of the days before the week
const earlier = dateStr(new Date(Date.parse(weekStart + 'T12:00:00') - 3 * 86400e3))
if (earlier >= monthStart) {
  const midMonth = { sessions: [{ started: Date.parse(earlier + 'T12:00:00') / 1000 }], daily: new Map([[earlier, { cost: 2 }], [today, { cost: 1 }]]) }
  check('set up earlier in the month: the week bill plus the list cost before the week', Math.abs(periodBill(accountThisWeek, '30d', midMonth) - 12.82) < 1e-9, String(periodBill(accountThisWeek, '30d', midMonth)))
}
process.exit(failed ? 1 : 0)
