// The popover asks again while the backend is still reading a long history, and says how far it is.
// Run: node tests/test_reading.mjs
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'desktop', 'plugin.js'), 'utf8')
const grab = (from, to) => src.slice(src.indexOf(from), src.indexOf(to))
const { reading, noteReading, untilRead, readingLine } = new Function(
  grab('const reading = {', 'const useReading = ') + '\nreturn { reading, noteReading, untilRead, readingLine }')()

let failed = 0
const check = (name, ok, detail) => {
  if (!ok) failed++
  console.log(ok ? 'ok  ' : 'FAIL', name, ok ? '' : detail || '')
}

const answers = [{ reading: { done: 2, total: 10 } }, { reading: { done: 7, total: 10 } }, { daily: [1] }]
let asked = 0
const notes = []
const got = await untilRead(async () => answers[asked++], r => notes.push(r), 1)
check('asks again until the real answer comes', asked === 3 && got.daily.length === 1, JSON.stringify({ asked, got }))
check('passes on how far the read is, then that it is over', JSON.stringify(notes) === JSON.stringify([{ done: 2, total: 10 }, { done: 7, total: 10 }, null]), JSON.stringify(notes))

const once = []
check('an answer that came at once is not asked for again', (await untilRead(async () => ({ sessions: [] }), r => once.push(r), 1)).sessions.length === 0 && once.length === 1 && once[0] === null)

const failedNotes = []
let threw = false
try { await untilRead(async () => { throw new Error('backend gone') }, r => failedNotes.push(r), 1) } catch { threw = true }
check('a failed ask still fails, and the reading note is cleared', threw && failedNotes.length === 1 && failedNotes[0] === null)

check('the line carries the share read', readingLine({ share: 0.4 }) === 'Reading your history 40%', readingLine({ share: 0.4 }))
check('and stays plain when there is nothing to count', readingLine({ share: 0 }) === 'Reading your history')

const seen = []
reading.subs.add(v => seen.push(v))
noteReading('/usage', { done: 1, total: 4 })
noteReading('/sessions', { done: 3, total: 4 })
noteReading('/usage', { done: 2, total: 8 }) // another read began, so the share over all of them fell
check('the share shown never goes back', reading.now.share === 0.75, JSON.stringify(reading.now))
noteReading('/usage', null)
check('the note stays while another read is still going', reading.now && reading.now.share === 0.75, JSON.stringify(reading.now))
noteReading('/sessions', null)
check('and goes when the last one ends', reading.now === null && seen[seen.length - 1] === null, JSON.stringify(seen))
process.exit(failed ? 1 : 0)
