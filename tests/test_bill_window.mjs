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
check('a machine whose chats start after the month began does not take the month\'s bill as its own', periodBill(account, '30d', newMachine) === null || monthStart === today)
check('so its 30 days show what its chats cost', Math.abs(periodSpend(newMachine, account, '30d', 'all') - 1.14) < 1e-9 || monthStart === today, String(periodSpend(newMachine, account, '30d', 'all')))
check('today\'s bill is its own', periodBill(account, 'today', newMachine) === 1.21)
const oldMachine = chats(daysBefore(monthStart, 3))
check('a machine with chats from before the month uses the month\'s bill', periodBill(account, '30d', oldMachine) === 29.01 && periodSpend(oldMachine, account, '30d', 'all') === 29.01)
check('the week the same way', periodBill(account, '7d', chats(daysBefore(accountWindowStart('7d'), 1))) === 1.21)
check('no chats on record, no bill to compare', periodBill(account, '30d', { sessions: [] }) === null)
check('no account, no bill', periodBill(null, '30d', oldMachine) === null && periodBill({ month: null }, '30d', oldMachine) === null)
process.exit(failed ? 1 : 0)
