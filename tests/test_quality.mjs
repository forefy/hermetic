// Quality by provider: when a provider counts as worse, the order rows show in, and skipping a provider for
// one model in config.yaml. Run: node tests/test_quality.mjs
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'desktop', 'plugin.js'), 'utf8')
const grabFn = name => { const a = src.indexOf('function ' + name + '('); return src.slice(a, src.indexOf('\n}\n', a) + 2) }
const line = re => src.match(re)[0]
const { fisherGreater, qualityBase, qualityDay, qualityModel, qualityWorst, buildYamlChange } = new Function(
  [line(/^const num = .*$/m), line(/^const Q_FEW = .*$/m), line(/^const Q_FEW_DAY = .*$/m), line(/^const qualitySlug = .*$/m), line(/^const qualitySkipped = .*$/m),
    line(/^const fmtPct = .*$/m), grabFn('fisherGreater'), grabFn('qualityBase'), grabFn('qualityDay'), grabFn('qualityModel'), grabFn('qualityWorst'), grabFn('buildYamlChange')].join('\n') +
  '\nreturn { fisherGreater, qualityBase, qualityDay, qualityModel, qualityWorst, buildYamlChange }'
)()

let failed = 0
const check = (name, ok, got) => { if (!ok) failed++; console.log((ok ? 'ok   ' : 'FAIL ') + name + (ok ? '' : ' ' + JSON.stringify(got))) }

// Fisher's exact test against known values
check('fisher: 7 of 20 vs 3 of 80 is significant', Math.abs(fisherGreater(7, 20, 3, 80) - 0.00039172) < 1e-7, fisherGreater(7, 20, 3, 80))
check('fisher: the same rate is not', fisherGreater(2, 20, 8, 80) > 0.4, fisherGreater(2, 20, 8, 80))

const days = ['2026-11-01', '2026-11-02', '2026-11-03']
// day rows: [calls, replies, pushed back, output tokens, seconds, thinking tokens, cut off, empty]
const d = (calls, replies, push) => [calls, replies, push, calls * 100, calls * 2, calls * 40, 0, 0]
const entry = { model: 'x/m', providers: [
  { name: 'Big', days: { '2026-11-01': d(300, 40, 1), '2026-11-02': d(300, 40, 1), '2026-11-03': d(200, 20, 1) } },
  { name: 'Bad', quant: 'fp4', days: { '2026-11-02': d(60, 12, 4), '2026-11-03': d(50, 10, 3) } },
  { name: 'Tiny', days: { '2026-11-03': d(4, 2, 2) } },
  { name: 'Changed', days: { '2026-11-01': d(20, 3, 0) }, events: [{ day: '2026-11-01', what: 'Precision changed' }, { day: '2026-10-01', what: 'old' }] },
  { name: 'Idle', days: { '2026-10-01': d(50, 10, 9) } }
] }
const q = qualityModel(entry, days)
const by = Object.fromEntries(q.providers.map(p => [p.name, p]))
check('a provider with a real gap is worse', by.Bad.worse && Math.abs(by.Bad.rate - 7 / 22) < 1e-9, by.Bad)
check('the big provider is not', !by.Big.worse, by.Big)
check('two of two pushbacks are too few replies to judge', !by.Tiny.worse && by.Tiny.replies < 10, by.Tiny)
check('only changes inside the period count', by.Changed.events.length === 1, by.Changed.events)
check('a provider with no calls this period is left out', !by.Idle && q.calls === 934, q.calls)
check('flagged providers come first, then by calls', q.providers.map(p => p.name).join() === 'Bad,Changed,Big,Tiny', q.providers.map(p => p.name))
check('speed and thinking are per period', by.Big.speed === 50 && by.Big.thinking === 40, by.Big)
check('the status line names the worse provider', JSON.stringify(qualityWorst({ models: [entry] }, days)) === '{"model":"x/m","provider":"Bad"}')
check('no worse provider when the period has none', qualityWorst({ models: [entry] }, ['2026-10-01']) === null)
const tagged = { model: 'x/m', providers: entry.providers.map(p => p.name === 'Bad' ? Object.assign({}, p, { tag: 'bad/fp4' }) : p) }
check('a skipped provider is not named again', qualityWorst({ models: [tagged] }, days, 'provider_routing:\n  ignore:\n    - bad\n') === null)
check('skipping another provider does not count', qualityWorst({ models: [tagged] }, days, 'provider_routing:\n  ignore:\n    - other\n') !== null)

// each day's level comes from its worst signal, against the provider's own usual thinking and speed
const usual = qualityBase({ a: [20, 0, 0, 2000, 20, 4000, 0, 0], b: [10, 0, 0, 1000, 10, 2000, 0, 0], c: [3, 0, 0, 900, 1, 0, 0, 0] })
check('usual thinking and speed are medians over busy days', usual.think === 200 && usual.speed === 100, usual)
const day = r => qualityDay(r, usual)
check('a normal day is fine', day([20, 0, 0, 2000, 20, 4000, 0, 0]).level === 0)
check('a quiet day is too few to tell', day([3, 1, 1, 300, 3, 600, 0, 0]).level === null)
check('cut-off answers make it bad', day([20, 0, 0, 2000, 20, 4000, 3, 0]).level === 3 && day([20, 0, 0, 2000, 20, 4000, 3, 0]).why[0] === '3 of 20 answers cut off')
check('one empty reply in 20 is a warning', day([20, 0, 0, 2000, 20, 4000, 0, 1]).level === 3 && day([40, 0, 0, 4000, 40, 8000, 0, 1]).level === 2)
check('thinking well below its usual', day([20, 0, 0, 2000, 20, 1600, 0, 0]).level === 2 && /40% of its usual/.test(day([20, 0, 0, 2000, 20, 1600, 0, 0]).why[0]) && day([20, 0, 0, 2000, 20, 800, 0, 0]).level === 3)
check('a speed jump is a warning', day([20, 0, 0, 4000, 20, 4000, 0, 0]).level === 2 && /2.0× its usual speed/.test(day([20, 0, 0, 4000, 20, 4000, 0, 0]).why[0]))
check('pushback still counts', day([20, 5, 3, 2000, 20, 4000, 0, 0]).level === 3)
const cutting = qualityModel({ model: 'x/m', providers: [
  { name: 'Clean', days: { '2026-11-03': [400, 0, 0, 40000, 400, 80000, 2, 0] } },
  { name: 'Cuts', days: { '2026-11-03': [100, 0, 0, 10000, 100, 20000, 9, 0] } }] }, ['2026-11-03'])
const cuts = cutting.providers.find(p => p.name === 'Cuts')
check('more cut-off answers than elsewhere makes a provider worse', cuts.worse && /9% of its answers were cut off, 1% elsewhere/.test(cuts.why[0]), cuts.why)

// skipping a provider for every model, in provider_routing.ignore
const skip = yaml => buildYamlChange(yaml, { kind: 'ignore_provider', slug: 'deepinfra' })
const base = 'model:\n  default: z-ai/glm-5.3\nprovider_routing:\n  data_collection: deny\n  zdr: true\n\nagent:\n  x: 1\n'
const a = skip(base)
check('adds an ignore list under provider_routing', a.yaml === 'model:\n  default: z-ai/glm-5.3\nprovider_routing:\n  data_collection: deny\n  zdr: true\n  ignore:\n    - deepinfra\n\nagent:\n  x: 1\n', a.yaml)
check('the preview shows the routing block before and after', a.diff.length === 1 && a.diff[0].from.endsWith('zdr: true') && a.diff[0].to.endsWith('- deepinfra'), a.diff)
check('skipping it again changes nothing', skip(a.yaml) === null)
const listed = 'provider_routing:\n  ignore:\n    - novita\n  sort: price\n'
check('appended to an existing list', skip(listed).yaml === 'provider_routing:\n  ignore:\n    - novita\n    - deepinfra\n  sort: price\n', skip(listed).yaml)
const inline = 'provider_routing:\n  ignore: [novita]\n'
check('appended to an inline list', skip(inline).yaml === 'provider_routing:\n  ignore: [novita, deepinfra]\n', skip(inline).yaml)
const perModel = 'provider_routing:\n  models:\n    x/m:\n      ignore:\n      - deepinfra\n'
check('a model\'s own ignore list is not the global one', skip(perModel).yaml === 'provider_routing:\n  models:\n    x/m:\n      ignore:\n      - deepinfra\n  ignore:\n    - deepinfra\n', skip(perModel).yaml)
check('no provider_routing block at all', skip('model:\n  default: x\n').yaml.endsWith('\nprovider_routing:\n  ignore:\n    - deepinfra'))

console.log(failed ? failed + ' failed' : 'all ok')
process.exit(failed ? 1 : 0)
