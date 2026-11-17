// A chat's numbers come from hermetic on the machine the chat lives on, also when that is a second
// connection of the window. Where that machine has no hermetic, Costs reads Hermes' own chat list, plus
// the focused chat's live counters. Run: node tests/test_remote.mjs
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
const helpers = grab('const num = ', 'const fmtUsd = ') + grab('const dateStr = ', 'const dayLabel = ') + grab('const lastNDays = ', 'const dayStart = ')
const build = host => new Function('host', helpers + grab('const noRoute = ', 'async function loadProfiles()') +
  '\nreturn { noRoute, usageOfChats, sessionsOfChats, liveChat, chatListed, loadOwnChats, ownRows, awayMachine, machineOf, apartMachine, INSTALL_REQUEST, lastNDays, dateStr }')(host)

let failed = 0
const check = (name, ok, detail) => {
  if (!ok) failed++
  console.log(ok ? 'ok  ' : 'FAIL', name, ok ? '' : detail || '')
}
const near = (a, b) => Math.abs(a - b) < 1e-9

const { noRoute, usageOfChats, sessionsOfChats, liveChat, chatListed, lastNDays, dateStr } = build({})
const now = Date.now() / 1000
const noon = daysAgo => { const d = new Date(); d.setHours(12, 0, 0, 0); return d.getTime() / 1000 - daysAgo * 86400 }
const chat = (id, daysAgo, cost, extra) => Object.assign({
  id, title: id, model: 'vendor/model-a', api_call_count: 10, input_tokens: 1000, output_tokens: 100, cache_read_tokens: 5000,
  estimated_cost_usd: cost, actual_cost_usd: null, billing_base_url: 'https://api.vendor.example/v1',
  started_at: noon(daysAgo) - 600, last_active: noon(daysAgo)
}, extra || {})
const rows = [
  chat('today', 0, 1),
  chat('yesterday', 1, 2),
  chat('long', 1, 4, { started_at: noon(40) }), // started long before the period, used yesterday
  chat('subscription', 2, 0, { model: 'vendor/model-b', billing_base_url: 'https://chat.vendor.example/api' }),
  chat('old', 12, 8),
  chat('draft', 0, 0, { api_call_count: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 }),
  chat('no-model', 3, 0.5, { model: null })
]
const day = n => lastNDays(n + 1)[0]

check('a missing route is told from other failures', noRoute(new Error('404: {"detail":"Not Found"}')) && !noRoute(new Error('Request timed out')) && !noRoute(null))

const week = usageOfChats(rows, 7)
const byDay = Object.fromEntries(week.daily.map(d => [d.day, d]))
check('a chat counts on the day it was last active', near(byDay[day(0)].estimated_cost, 1) && near(byDay[day(1)].estimated_cost, 6), JSON.stringify(week.daily))
check('also one started before the period', byDay[day(1)].sessions === 2)
check('chats idle since before the period are left out', !byDay[day(12)] && near(week.daily.reduce((a, d) => a + d.estimated_cost, 0), 7.5), JSON.stringify(week.daily))
check('days come oldest first', week.daily.map(d => d.day).join() === week.daily.map(d => d.day).sort().join())
const unpriced = (byDay[day(2)].unpriced || {})['vendor/model-b']
check('a $0 chat with tokens hands its tokens over for a list price', !!unpriced && unpriced.input_tokens === 1000 && unpriced.cache_read_tokens === 5000, JSON.stringify(byDay[day(2)]))
check('a priced chat does not', !byDay[day(0)].unpriced)
const a = week.by_model.find(m => m.model === 'vendor/model-a')
check('models add up over the period', a && near(a.estimated_cost, 7) && a.input_tokens === 3000 && a.api_calls === 30, JSON.stringify(week.by_model))
check('with where they were billed', a && a.hosts.join() === 'api.vendor.example' && week.by_model.find(m => m.model === 'vendor/model-b').hosts.join() === 'chat.vendor.example')
check('a chat without a model counts in its day only', near(byDay[day(3)].estimated_cost, 0.5) && week.by_model.length === 2)
check('today alone', near(usageOfChats(rows, 1).daily.reduce((s, d) => s + d.estimated_cost, 0), 1))

const listed = sessionsOfChats(rows, 30)
check('the chat list drops drafts without a model call', listed.map(r => r.id).join() === 'today,yesterday,long,subscription,old,no-model', listed.map(r => r.id).join())
check('and chats idle for longer than the window', sessionsOfChats(rows, 7).every(r => r.id !== 'old'))
check('each chat sits on its last active day', listed.every(r => Object.keys(r.by_day).length === 1) && listed.find(r => r.id === 'long').by_day[day(1)] === 1, JSON.stringify(listed.find(r => r.id === 'long').by_day))
// the popover picks a period's chats by last activity and its total from the days: both must agree
const inWeek = sessionsOfChats(rows, 30).filter(r => Object.keys(r.by_day)[0] >= lastNDays(7)[0])
check('a period\'s total equals its chats', near(inWeek.reduce((s, r) => s + r.estimated_cost_usd, 0), week.daily.reduce((s, d) => s + d.estimated_cost, 0)))
check('a chat with no last activity falls back to its start', sessionsOfChats([chat('x', 2, 1, { last_active: null, started_at: noon(2) })], 7)[0].by_day[day(2)] === 1)
check('times are read as local days', dateStr(new Date(now * 1000)) === day(0))

// a bot's own chat is hidden from the list: the one in front of the user counts from its live counters
const counters = { model: 'vendor/model-a', input: 4000, output: 600, prompt: 30000, calls: 7 }
const liveRow = liveChat(counters, 'bot-chat')
check('the focused chat becomes a row from its counters', liveRow && liveRow.id === 'bot-chat' && liveRow.input_tokens === 4000 && liveRow.output_tokens === 600 && liveRow.cache_read_tokens === 26000 && liveRow.api_call_count === 7 && liveRow.model === 'vendor/model-a', JSON.stringify(liveRow))
check('with no cost of its own, so it is priced at list price', liveRow.estimated_cost_usd === 0 && !!(usageOfChats([liveRow], 1).daily[0].unpriced || {})['vendor/model-a'])
check('counted today', Object.keys(sessionsOfChats([liveRow], 1)[0].by_day)[0] === day(0))
check('nothing to add before the first reply or without a chat', liveChat({ input: 0, output: 0 }, 'x') === null && liveChat(counters, null) === null && liveChat(null, 'x') === null)
check('cached tokens never go below zero', liveChat({ input: 500, output: 10, prompt: 0 }, 'x').cache_read_tokens === 0)
check('a listed chat is found by its id or its lineage', chatListed([{ id: 'a' }], 'a') && chatListed([{ id: 'tip', _lineage_root_id: 'root' }], 'root') && chatListed([{ id: 'tip', _lineage_ids: ['root', 'mid', 'tip'] }], 'mid') && !chatListed([{ id: 'a' }], 'b'))

// one read of the chat list serves every loader of a refresh
let reads = 0
const withList = build({ listPersistedSessions: async (route, o) => { reads++; return { sessions: [{ id: o.profile, limit: o.limit, route }] } } })
const [r1, r2] = await Promise.all([withList.loadOwnChats(null, 'default'), withList.loadOwnChats(null, 'default')])
check('the chat list is read once for a refresh', reads === 1 && r1 === r2 && r1[0].id === 'default' && r1[0].limit === 500 && r1[0].route === null, JSON.stringify({ reads, r1 }))
await withList.loadOwnChats(null, 'work')
check('and once more for another profile', reads === 2)
const there = { connectionId: 'c1', profile: 'default', targetProfile: 'default' }
const far = await withList.loadOwnChats(there, 'default')
check('and for another machine, named by its route', reads === 3 && far[0].route === there && far !== r1)
let threw = false
try { await build({}).loadOwnChats(null, 'default') } catch { threw = true }
check('an older Hermes without that list fails instead of guessing', threw)
let fails = 0
const flaky = build({ listPersistedSessions: async () => { fails++; if (fails === 1) throw new Error('socket closed'); return { sessions: [] } } })
try { await flaky.loadOwnChats(null, 'default') } catch { /* the first read fails */ }
await new Promise(done => setTimeout(done, 0))
check('a failed read is not kept', (await flaky.loadOwnChats(null, 'default')).length === 0 && fails === 2)

const lister = sessions => build({ listPersistedSessions: async () => ({ sessions }) })
const hidden = await lister([chat('visible', 0, 1)]).ownRows({ route: null, live: { profile: 'default', row: liveRow } }, 'default')
check('the focused chat is added when the list does not have it', hidden.rows.length === 1 && hidden.live.length === 1 && hidden.live[0] === liveRow)
const shownToo = await lister([chat('bot-chat', 0, 1)]).ownRows({ route: null, live: { profile: 'default', row: liveRow } }, 'default')
check('and left to the list when it does, which has its real cost', shownToo.live.length === 0)
const other = await lister([]).ownRows({ route: null, live: { profile: 'default', row: liveRow } }, 'work')
check('it belongs to its own profile only', other.live.length === 0 && (await lister([]).ownRows({ route: null, live: null }, 'default')).live.length === 0)

// which machine the window is connected to
const conns = [{ id: 'local', kind: 'local', label: 'This device' }, { id: 'c1', kind: 'ssh', label: 'build-box', host: 'build.example.net', user: 'ops', port: 22, keyPath: '/keys/id_build' },
  { id: 'c2', kind: 'local', label: 'Other window' }, { id: 'c3', kind: 'remote', label: 'cloud-box', url: 'https://agents.example.net' }]
const machine = (id, connections = async () => conns) => build({ activeConnectionId: () => id, connections }).awayMachine()
check('this computer is not away', (await machine(null)) === null && (await machine('local')) === null && (await machine('c2')) === null)
check('a server is named by its label', (await machine('c1')) === 'build-box' && (await machine('c3')) === 'cloud-box')
check('or by its id when the list cannot be read', (await machine('c1', async () => { throw new Error('no registry') })) === 'c1' && (await machine('c9')) === 'c9')
check('an older Hermes without connections counts as this computer', (await build({}).awayMachine()) === null)

// the request for the agent of the machine that lacks hermetic: the chat in front of the user is its own
const { INSTALL_REQUEST } = build({})
check('the request asks that agent to install on its own machine', INSTALL_REQUEST === 'Install the hermetic plugin on this machine:\nhermes plugins install hermetic --enable', INSTALL_REQUEST)
check('and never to log in from outside, which made an agent open its own machine to itself', !/ssh|@/i.test(INSTALL_REQUEST))

// a bot on another machine than the one the window is connected to
let routeReads = 0
const routesOf = async () => { routeReads++; return [{ connectionId: 'local', profile: 'default', targetProfile: 'default' }, { connectionId: 'c1', profile: 'default', targetProfile: 'ops' }] }
const twoMachines = reach => build({ activeConnectionId: () => reach, connections: async () => conns, profileRoutes: routesOf })
const here = twoMachines(null)
check('a chat on the machine the window is connected to is not apart', (await here.apartMachine({ connectionId: 'local', profile: 'default' })) === null && (await here.apartMachine(null)) === null && (await here.apartMachine({ connectionId: '', profile: 'default' })) === null && (await twoMachines('c1').apartMachine({ connectionId: 'c1', profile: 'default' })) === null)
const bot = await here.apartMachine({ connectionId: 'c1', profile: 'default' })
check('a bot on a second connection is', bot && bot.name === 'build-box' && !bot.local && bot.profile === 'default', JSON.stringify(bot))
check('read through its route, as the profile that machine serves', bot.route.connectionId === 'c1' && bot.target === 'ops', JSON.stringify(bot))
await here.apartMachine({ connectionId: 'c1', profile: 'default' })
check('the routes are asked for once, not on every refresh', routeReads === 1)
const home = await twoMachines('c1').apartMachine({ connectionId: 'local', profile: 'default' })
check('this computer can be the one apart, when the window sits on a server', home && home.local && home.name === 'this computer' && home.route.connectionId === 'local', JSON.stringify(home))
const bare = await build({ activeConnectionId: () => null }).apartMachine({ connectionId: 'c7', profile: 'work' })
check('without a route list one is made from the chat\'s own machine and profile', bare && bare.route.connectionId === 'c7' && bare.route.profile === 'work' && bare.target === 'work' && bare.name === 'c7', JSON.stringify(bare))

check('a chat\'s machine is named only when it is not the window\'s own', here.machineOf({ connectionId: 'c1', profile: 'default' }) === 'c1' && here.machineOf({ connectionId: 'local', profile: 'default' }) === '' && here.machineOf(null) === '' && twoMachines('c1').machineOf({ connectionId: 'c1', profile: 'default' }) === '' && twoMachines('c1').machineOf({ connectionId: 'local', profile: 'default' }) === 'local')

// the bot of a chat on another machine goes by the name that machine gives it, read through the app
const mine = { profiles: [{ name: 'default', is_default: true, bot_title: 'desk-bot' }, { name: 'runner', is_default: false }] }
const theirs = { profiles: [{ name: 'default', is_default: true, bot_title: 'cloud-bot' }, { name: 'ops-team', is_default: false }] }
const namesOf = (list, wait) => {
  const asked = []
  const names = new Function('host', grab('const botLabel = ', '// ---- chats the backend cannot answer for') + grab('const profileRows = ', 'async function loadAnalytics(').replace('FAR_PROFILES_WAIT_MS = 4000', 'FAR_PROFILES_WAIT_MS = ' + (wait || 4000)) +
    '\nreturn { loadProfiles, loadFarProfiles }')({ profiles: { list: scope => { asked.push(scope || null); return list(scope) } } })
  return { ...names, asked }
}
const app = namesOf(async scope => (scope && scope.connectionId === 'c1' ? theirs : mine))
const farBots = await app.loadFarProfiles({ connectionId: 'c1', profile: 'default' })
check('another machine\'s bots go by the names that machine gives them', farBots && farBots.length === 2 && farBots[0].name === 'default' && farBots[0].label === 'cloud-bot' && farBots[1].label === 'Ops Team', JSON.stringify(farBots))
check('asked of the app for that machine, next to the window\'s own list', app.asked.length === 2 && app.asked[0].connectionId === 'c1' && app.asked[0].profile === 'default' && app.asked[1] === null, JSON.stringify(app.asked))
await app.loadFarProfiles({ connectionId: 'c1', profile: 'default' })
check('and kept, not asked again on every refresh', app.asked.length === 2)
check('the window\'s own bots keep their own names', (await app.loadProfiles())[0].label === 'desk-bot')
const oldApp = namesOf(async () => mine) // answers with the window's own list whatever machine is named
check('an app that cannot ask by machine never lends this machine\'s bot name to another', (await oldApp.loadFarProfiles({ connectionId: 'c1', profile: 'default' })) === null)
let down = true
const flakyApp = namesOf(async scope => { if (scope && down) throw new Error('unreachable'); return scope ? theirs : mine })
check('a machine that cannot be reached has no names yet', (await flakyApp.loadFarProfiles({ connectionId: 'c1', profile: 'default' })) === null)
down = false
check('and is asked again the next time', ((await flakyApp.loadFarProfiles({ connectionId: 'c1', profile: 'default' })) || [{}])[0].label === 'cloud-bot')
const slowApp = namesOf(scope => new Promise(done => setTimeout(() => done(scope ? theirs : mine), 120)), 20)
const early = await slowApp.loadFarProfiles({ connectionId: 'c1', profile: 'default' })
await new Promise(done => setTimeout(done, 160))
const late = await slowApp.loadFarProfiles({ connectionId: 'c1', profile: 'default' })
check('a slow answer is not waited for, and shows the next time', early === null && late && late[0].label === 'cloud-bot' && slowApp.asked.length === 2, JSON.stringify({ early, late, n: slowApp.asked.length }))

// what is on screen belongs to one machine
const show = new Function(grab('const NOTHING_YET = ', 'function useMeterData()') + '\nreturn { shownFor, failedFor }')()
const homeNumbers = { at: '', loading: false, error: null, data: { total: 7 }, account: { credits: 110 }, prices: { p: 1 } }
const farNumbers = { at: 'c1', loading: false, error: null, data: { total: 1 }, account: null, prices: { p: 1 } }
const lastSeen = new Map()
const waiting = show.shownFor(homeNumbers, lastSeen, 'c1')
check('while another machine loads, this machine\'s numbers and account are not shown for it', waiting.data === null && waiting.account === null && waiting.loading && waiting.at === 'c1' && waiting.prices === homeNumbers.prices, JSON.stringify(waiting))
lastSeen.set('', homeNumbers).set('c1', farNumbers)
check('a machine seen before shows its own last numbers at once', show.shownFor(homeNumbers, lastSeen, 'c1') === farNumbers && show.shownFor(farNumbers, lastSeen, '') === homeNumbers)
check('the focused machine\'s numbers show as they are', show.shownFor(farNumbers, lastSeen, 'c1') === farNumbers && show.shownFor({ loading: true, data: null }, lastSeen, 'c1').loading === true)
const failedFar = show.failedFor(homeNumbers, new Map(), 'c1', 'timed out')
check('a failed look at another machine keeps this machine\'s numbers out', failedFar.at === 'c1' && failedFar.data === null && failedFar.error === 'timed out' && failedFar.loading === false, JSON.stringify(failedFar))
const failedHome = show.failedFor(homeNumbers, lastSeen, '', 'timed out')
check('a failed look at the same machine keeps its last numbers', failedHome.data === homeNumbers.data && failedHome.error === 'timed out' && failedHome.at === '')
check('and one at a machine seen before falls back to that machine\'s', show.failedFor(homeNumbers, lastSeen, 'c1', 'x').data === farNumbers.data)

// the bill of a machine whose hermetic names no account: the chat's own Hermes reports it
const usageText = 'Session Token Usage\n────────────────────\nModel: openrouter/some-model\nInput tokens:                 121,643\nAPI calls:                    5'
const billText = '📈 Account limits\nProvider: openrouter\nAPI key quota: 99% remaining (1% used) • $98.79 of $100.00 remaining • resets daily\nCredits balance: $110.77\nAPI key usage: $29.01 total • $1.21 today • $1.21 this week • $29.01 this month'
const reportsOf = answer => {
  const asked = []
  const fns = new Function('host', grab('const money = ', 'function parseAccountLines(') + grab('function parseAccountLines(', '// What actually stops requests') + grab('const chatAccounts = new Map()', '// ---- pricing math') +
    '\nreturn { loadChatAccount }')({
    request: async (method, params) => { asked.push(['here', method, params]); return answer('here') },
    requestProfile: async (route, method, params) => { asked.push([route.connectionId, method, params]); return answer(route.connectionId) }
  })
  return { ...fns, asked }
}
const reports = reportsOf(where => ({ output: usageText + '\n\n' + billText.replace('$1.21 today', where === 'c1' ? '$1.21 today' : '$23.42 today') }))
const farBill = await reports.loadChatAccount('run-1', { connectionId: 'c1', profile: 'default' })
check('the bill of a chat on another machine comes from that machine\'s own Hermes', farBill && farBill.today === 1.21 && farBill.balance === 110.77 && farBill.total === 29.01 && farBill.limit === 100 && farBill.remaining === 98.79 && farBill.limitReset === 'daily', JSON.stringify(farBill))
check('asked as that chat\'s usage report, on its own machine', reports.asked.length === 1 && reports.asked[0][0] === 'c1' && reports.asked[0][1] === 'slash.exec' && reports.asked[0][2].command === '/usage' && reports.asked[0][2].session_id === 'run-1', JSON.stringify(reports.asked))
await reports.loadChatAccount('run-1', { connectionId: 'c1', profile: 'default' })
check('and kept for a minute', reports.asked.length === 1)
const homeBill = await reports.loadChatAccount('run-2', null)
check('each machine has its own bill', homeBill.today === 23.42 && reports.asked.length === 2 && reports.asked[1][0] === 'here' && (await reports.loadChatAccount('run-1', { connectionId: 'c1', profile: 'default' })).today === 1.21)
const noBill = reportsOf(() => ({ output: usageText }))
check('a model name is not taken for an account', (await noBill.loadChatAccount('run-1', { connectionId: 'c1', profile: 'default' })) === null)
await noBill.loadChatAccount('run-1', { connectionId: 'c1', profile: 'default' })
check('a machine is asked once a minute at most, also when it had no account to report', noBill.asked.length === 1)
check('no chat, no question', (await reportsOf(() => ({ output: billText })).loadChatAccount(null, { connectionId: 'c1', profile: 'default' })) === null)
const noReport = reportsOf(() => { throw new Error('session not found') })
check('a Hermes that cannot report leaves the bill empty', (await noReport.loadChatAccount('run-1', { connectionId: 'c1', profile: 'default' })) === null && (await noReport.loadChatAccount('run-1', null)) === null)
await noReport.loadChatAccount('run-1', { connectionId: 'c1', profile: 'default' })
check('and is not asked again right away', noReport.asked.length === 2, String(noReport.asked.length))
const oldSdk = new Function('host', grab('const money = ', 'function parseAccountLines(') + grab('function parseAccountLines(', '// What actually stops requests') + grab('const chatAccounts = new Map()', '// ---- pricing math') + '\nreturn { loadChatAccount }')({ request: async () => ({ output: billText }) })
check('an app that cannot ask another machine never shows this machine\'s bill for it', (await oldSdk.loadChatAccount('run-1', { connectionId: 'c1', profile: 'default' })) === null)

// where a chat's requests go is known at once from the chat itself, before any look has run
const aims = (reach, named) => new Function('host', 'namedApi', helpers + grab('const noRoute = ', 'async function loadProfiles()') + '\nreturn { aimOf, apartMachine }')(
  { activeConnectionId: () => reach, connections: async () => conns, profileRoutes: routesOf }, () => (named ? () => {} : null))
const aimsHere = aims(null, true)
check('a chat on this window\'s own machine is asked through the SDK', aimsHere.aimOf({ connectionId: 'local', profile: 'default' }) === null && aimsHere.aimOf(null) === null)
const firstAim = aimsHere.aimOf({ connectionId: 'c1', profile: 'default' })
check('a chat on another machine is asked there from the first moment', firstAim && firstAim.connectionId === 'c1' && firstAim.profile === 'default' && firstAim.target === 'default' && firstAim.mute === false, JSON.stringify(firstAim))
await aimsHere.apartMachine({ connectionId: 'c1', profile: 'default' }) // a look reads the routes
check('and by the name that machine knows its profile by, once the routes are read', aimsHere.aimOf({ connectionId: 'c1', profile: 'default' }).target === 'ops')
check('an app that cannot ask by name leaves that machine named and unasked', aims(null, false).aimOf({ connectionId: 'c1', profile: 'default' }).mute === true)

// a machine that does not answer is told from one that has no hermetic
const healthOf = answer => {
  const fns = new Function('api', 'aim', grab('const noRoute = ', '// Hermes keeps one total per chat') + "const aimKey = to => (to ? to.connectionId : '')\nconst offAt = new Set()\nconst missingRoutes = new Set([' /quality', 'c1 /quality'])\n" + grab('const builds = new Map()', 'async function loadAux(') + '\nreturn { loadHealth, offAt, builds, missingRoutes }')(answer, null)
  return fns
}
const answering = healthOf(async () => ({ version: '1.5.0', missing: ['x'] }))
check('a machine that answers tells its version and what it could not find', (await answering.loadHealth()).join() === 'x' && answering.builds.get('').version === '1.5.0' && !answering.offAt.has(''))
check('a new version there is asked again for the routes the old one lacked, on that machine only', !answering.missingRoutes.has(' /quality') && answering.missingRoutes.has('c1 /quality'))
const withoutHermetic = healthOf(async () => { throw new Error('404: {"detail":"Not Found"}') })
check('one without hermetic is marked, and the look goes on with what Hermes keeps', (await withoutHermetic.loadHealth()).length === 0 && withoutHermetic.offAt.has(''))
const unanswering = healthOf(async () => { throw new Error('Timed out connecting to Hermes backend after 10000ms') })
check('one that does not answer is not asked anything else', (await unanswering.loadHealth()) === null && !unanswering.offAt.has(''))
let healthAsk = null
await healthOf(async req => { healthAsk = req; return {} }).loadHealth()
check('and is not waited for long', healthAsk && healthAsk.timeoutMs === 10000, JSON.stringify(healthAsk))

// the backend's account: "none to tell" is not "no answer"
const accountOf = (answer, rpc) => new Function('api', 'host', "const OWN = '/api/plugins/hermetic'\n" + grab('const money = ', 'function parseAccountLines(') + grab('function parseAccountLines(', '// What actually stops requests') + grab('async function loadAccount(sid, profile)', 'const chatAccounts = new Map()') +
  '\nreturn { loadAccount }')(answer, { request: rpc || (async () => ({})) })
check('the backend\'s account is read from its lines', (await accountOf(async () => ({ provider: 'openrouter', lines: billText.split('\n'), account: { budgets: [{ label: 'b' }] } })).loadAccount(null)).today === 1.21)
let accountAsk = null
await accountOf(async req => { accountAsk = req; return { lines: [] } }).loadAccount(null, 'company-runner')
check('each profile is asked for its own account, as it can have its own key', accountAsk && accountAsk.profile === 'company-runner', JSON.stringify(accountAsk))
check('a backend that answers without an account says so', (await accountOf(async () => ({ provider: 'auto', lines: [], account: null })).loadAccount(null)) === null)
check('a backend that does not answer says nothing, so its machine is not asked more', (await accountOf(async () => { throw new Error('Timed out') }).loadAccount(null)) === undefined && (await accountOf(async () => { throw new Error('Timed out') }).loadAccount('run-1')) === undefined)

// requests go to the machine of the focused chat: the primary one through the SDK, another one by name
const sent = []
const named = []
const store = new Map()
const storeFns = "const sget = (k, fb) => (store.has(k) ? store.get(k) : fb)\nconst sset = (k, v) => store.set(k, v)\n"
const door = new Function('pluginRest', 'window', 'store', "const OWN = '/api/plugins/hermetic'\n" + storeFns + grab('let aim = null', '// the last data each AAI') +
  '\nreturn { api, aimAt: v => { aim = v }, offAt, backendOff, billedKey, watchGuardOf, guardMachines }')(
  async (rel, how) => { sent.push([rel, how && how.method]); return { ok: 'primary' } },
  { hermesDesktop: { api: async req => { named.push(req); return { ok: req.connectionId } } } }, store)
const usage = { path: '/api/plugins/hermetic/usage?days=7' }
check('a chat on the primary machine asks through the SDK', (await door.api(usage)).ok === 'primary' && sent.length === 1 && sent[0][0] === '/usage?days=7&profile=default&reading=1' && !named.length, JSON.stringify({ sent, named }))
door.aimAt({ connectionId: 'c1', profile: 'default', target: 'default' })
check('a chat on another connection asks that machine by name', (await door.api(usage)).ok === 'c1' && sent.length === 1 && named.length === 1 && named[0].connectionId === 'c1' && named[0].profile === 'default' && named[0].path === '/api/plugins/hermetic/usage?days=7&profile=default&reading=1', JSON.stringify(named))
await door.api({ path: '/api/plugins/hermetic/config', method: 'PUT', body: { a: 1 } })
check('changes go to that machine too', named.length === 2 && named[1].method === 'PUT' && named[1].body.a === 1 && named[1].path === '/api/plugins/hermetic/config?profile=default' && sent.length === 1, JSON.stringify(named[1]))
await door.api({ path: '/api/plugins/hermetic/hdr/guard/asks?wait=25', here: true })
check('the guard\'s questions stay with the primary machine', sent.length === 2 && sent[1][0].startsWith('/hdr/guard/asks') && named.length === 2, JSON.stringify(sent))
check('each machine keeps its own bill', door.billedKey() === 'billed@c1')
door.aimAt({ connectionId: 'c1', profile: 'default', target: 'ops' })
await door.api(usage)
check('a profile goes by the name that machine knows it by', named[2].path === '/api/plugins/hermetic/usage?days=7&profile=ops&reading=1' && named[2].profile === 'default', named[2].path)
await door.api({ path: '/api/plugins/hermetic/usage?days=7&profile=work' })
check('another profile is left as asked', named[3].path.includes('profile=work'), named[3].path)

// a machine without the backend is asked for its health only, and only that machine
door.aimAt({ connectionId: 'c1', profile: 'default', target: 'default' })
door.offAt.add('c1')
let refused = null
try { await door.api(usage) } catch (e) { refused = e }
let refusedWrite = null
try { await door.api({ path: '/api/plugins/hermetic/config', method: 'PUT', body: {} }) } catch (e) { refusedWrite = e }
check('without a backend there, requests fail at once as a missing route', named.length === 4 && noRoute(refused) && noRoute(refusedWrite) && door.backendOff(), JSON.stringify({ n: named.length, refused: String(refused) }))
await door.api({ path: '/api/plugins/hermetic/health' })
check('except the health check, which notices the backend coming', named.length === 5 && named[4].path.startsWith('/api/plugins/hermetic/health'), JSON.stringify(named[4]))
await door.api({ path: '/api/plugins/hermetic/hdr/guard/asks?wait=25&have=x', here: true })
check('and the primary machine is still asked', sent.length === 3)
door.aimAt(null)
check('its own chats are not held back by the other machine', (await door.api({ path: '/api/plugins/hermetic/sessions?days=30' })).ok === 'primary' && !door.backendOff() && door.billedKey() === 'billed')
door.offAt.add('')
let refusedHere = null
try { await door.api(usage) } catch (e) { refusedHere = e }
door.aimAt({ connectionId: 'c2', profile: 'default', target: 'default' })
check('and the other way round', noRoute(refusedHere) && (await door.api(usage)).ok === 'c2')

// a guard question belongs to the machine that asked: it is answered there, whatever chat is in front
door.offAt.clear()
door.aimAt({ connectionId: 'c1', profile: 'default', target: 'default' })
const sentBefore = sent.length, namedBefore = named.length
await door.api({ path: '/api/plugins/hermetic/hdr/guard/answer', method: 'POST', body: { id: 'x' }, on: null })
check('an answer for this machine goes here while another machine\'s chat is in front', sent.length === sentBefore + 1 && named.length === namedBefore)
door.aimAt(null)
await door.api({ path: '/api/plugins/hermetic/hdr/guard/answer', method: 'POST', body: { id: 'y' }, on: { connectionId: 'c2', profile: 'default', target: 'default' } })
check('and one for another machine goes there while this machine\'s chat is in front', named.length === namedBefore + 1 && named[named.length - 1].connectionId === 'c2' && sent.length === sentBefore + 1)
door.watchGuardOf({ connectionId: 'c1', profile: 'default', target: 'ops' }, 'build-box')
check('a machine with hermetic is remembered for its guard questions, across restarts', door.guardMachines.get('c1').name === 'build-box' && store.get('guardMachines').length === 1 && store.get('guardMachines')[0].target === 'ops')
const again = new Function('pluginRest', 'window', 'store', "const OWN = '/api/plugins/hermetic'\n" + storeFns + grab('let aim = null', '// the last data each AAI') + '\nreturn { guardMachines }')(null, {}, store)
check('and watched again after a restart', again.guardMachines.get('c1') && again.guardMachines.get('c1').target === 'ops')

// an app without a way to ask by name: the machine is still the one in view, and is never asked as the primary one
door.offAt.clear()
door.aimAt({ connectionId: 'c3', profile: 'default', target: 'default', mute: true })
const sentSoFar = [sent.length, named.length]
let unasked = null
try { await door.api(usage) } catch (e) { unasked = e }
check('a machine that cannot be asked gets no request, and neither does the primary one in its place', !!unasked && sent.length === sentSoFar[0] && named.length === sentSoFar[1], String(unasked))
check('its bill and its switch stay its own', door.billedKey() === 'billed@c3' && !door.backendOff())
await door.api({ path: '/api/plugins/hermetic/hdr/guard/asks?wait=25', here: true })
check('while the guard still asks the primary machine', sent.length === sentSoFar[0] + 1)

// a route an older hermetic lacks is asked once per machine, then left alone
const asked = []
const routes = new Function('pluginRest', 'window', "const OWN = '/api/plugins/hermetic'\nconst noRoute = e => /404|Not Found/i.test(String(e && e.message))\nconst sget = (k, fb) => fb\nconst sset = () => {}\n" + grab('let aim = null', '// the last data each AAI') +
  '\nreturn { askRoute, missingRoutes, aimAt: v => { aim = v }, offAt }')(
  async rel => { asked.push(['here', rel]); throw new Error('404: {"detail":"Not Found"}') },
  { hermesDesktop: { api: async req => { asked.push([req.connectionId, req.path]); if (req.connectionId === 'c1') throw new Error('404: {"detail":"Not Found"}'); return { models: [] } } } })
const quality = { path: '/api/plugins/hermetic/quality' }
routes.aimAt({ connectionId: 'c1', profile: 'default', target: 'default' })
let gone = 0
for (let i = 0; i < 3; i++) { try { await routes.askRoute('/quality', quality) } catch (e) { if (noRoute(e)) gone++ } }
check('a route that machine lacks is asked once, and answers as missing after that', gone === 3 && asked.filter(x => x[0] === 'c1').length === 1, JSON.stringify(asked))
routes.aimAt({ connectionId: 'c2', profile: 'default', target: 'default' })
check('another machine is still asked', (await routes.askRoute('/quality', quality)).models.length === 0 && asked.filter(x => x[0] === 'c2').length === 1)
routes.aimAt({ connectionId: 'c3', profile: 'default', target: 'default' })
routes.offAt.add('c3')
try { await routes.askRoute('/quality', quality) } catch { /* no backend there */ }
check('a machine without hermetic at all is not marked route by route', !routes.missingRoutes.has('c3 /quality'))

// running chats and cache resets belong to one machine: the focused chat's is known, any other is the window's own
const ticks = new Function('num', 'sget', 'sset', 'priceOf', 'costAt', 'LIVE_WINDOW_MS',
  "let aim = null\nconst aimKey = to => (to ? to.connectionId : '')\n" + grab('const live = new Map()', '// ---- model ---') +
  '\nreturn { recordTick, liveRates, resetsNow: () => resets, aimAt: v => { aim = v } }')(
  v => (typeof v === 'number' && isFinite(v) ? v : 0), () => null, () => {}, () => ({ in: 1, out: 2, cache: 0.1 }),
  (p, i, o, c) => (i * p.in + o * p.out + c * p.cache) / 1e6, 600000)
const tick = (calls, input, cache) => ({ model: 'vendor/model-a', calls, input, output: calls * 100, cache_read_tokens: cache, context_used: 60000 })
ticks.recordTick('here-1', tick(1, 1000, 50000), true)
ticks.recordTick('here-1', tick(2, 2000, 110000), true)
ticks.aimAt({ connectionId: 'c1', profile: 'default', target: 'default' })
ticks.recordTick('there-1', tick(1, 1000, 50000), true)
ticks.recordTick('there-1', tick(2, 62000, 50000), true) // the whole context sent fresh again: a cache reset
ticks.recordTick('here-2', tick(1, 500, 20000), false) // some other chat of the window ticks meanwhile
ticks.recordTick('here-2', tick(2, 900, 40000), false)
const running = ticks.liveRates({}, 'vendor/model-a')
const where = Object.fromEntries(running.map(r => [r.sid, r.at]))
check('a running chat is counted for its own machine', where['here-1'] === '' && where['there-1'] === 'c1' && where['here-2'] === '', JSON.stringify(where))
check('so another machine\'s agents never show as running here', running.filter(r => r.at === 'c1').length === 1 && running.filter(r => r.at === '').length === 2)
const marks = ticks.resetsNow()
check('a cache reset carries its machine too', marks.length === 1 && marks[0].sid === 'there-1' && marks[0].at === 'c1', JSON.stringify(marks))
// a hermetic behind the latest that Hermes will not update: the command, or a request for that machine's agent
const upd = new Function(grab('const UPDATE_CMD = ', 'const UpdateNote = ') + grab('const olderVersion = ', 'async function loadProfiles()') + '\nreturn { updateRequest, olderVersion }')()
const pinned = { never: true, auto: false, fix: 'hermes plugins remove hermetic && hermes plugins install https://github.com/forefy/hermetic --enable --force' }
check('another machine gets a request for its agent', upd.updateRequest(pinned, 'build-box') === 'Update the hermetic plugin on this machine to the latest version:\n' + pinned.fix)
check('this machine gets the command alone', upd.updateRequest(pinned, null) === pinned.fix)
check('an older backend that does not say how it was installed gets the plain update', upd.updateRequest(null, null) === 'hermes plugins update hermetic')
check('a linked folder has nothing to run', upd.updateRequest({ never: true, auto: false, fix: null }, null) === null)
check('versions compare by number, not by text', upd.olderVersion('1.4.0', '1.5.0') && upd.olderVersion('1.9.0', '1.10.0') && upd.olderVersion('1.5', '1.5.1') && !upd.olderVersion('1.5.0', '1.5.0') && !upd.olderVersion('2.0.0', '1.9.9'))
check('an unknown version is never called outdated', !upd.olderVersion(null, '1.5.0') && !upd.olderVersion('1.5.0', null) && !upd.olderVersion('dev', '1.5.0'))
process.exit(failed ? 1 : 0)
