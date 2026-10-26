// DriveVoice Agent Lab (Project 2 · R2 step 0): gold replay for extension suites.
// Mirrors upstream bench/runner/run-gold.mjs exactly, but loads cases-ext files.
// Purpose: verify the extension suites' state assertions against the real
// service executors before any model run, so service-behavior differences are
// not misattributed to the model.
// Run from repo root:
//   node examples/smart-cockpit/bench/cases-ext/run-gold-ext.mjs [--file asr-noise.jsonl] [--out report.json]
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { loadCockpitEnvironment } from '../../bootstrap/environment.mjs'
import { parseJsonl, routeCasesExpectedPaths } from '../evaluator/cases.mjs'
import { scoreTrace, summarizeScores } from '../evaluator/score.mjs'

const ALL_FILES = [
  'interruption-correction.jsonl',
  'asr-noise.jsonl',
  'safety-confirmation.jsonl',
  'fuzzy-multi-intent.jsonl',
]

function parseArgs(argv) {
  const args = new Map()
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      args.set(argv[i].slice(2), argv[i + 1]?.startsWith('--') ? true : argv[++i])
    }
  }
  return args
}

async function replayCase(caseItem, { harness }) {
  const service = harness.createBenchmarkService()
  const cockpitId = caseItem.id
  await harness.setupBenchmarkCase(caseItem, { service, cockpitId })
  const calls = []
  const assistantMessages = []
  const stateSnapshots = []
  for (const [turnIndex] of caseItem.turns.entries()) {
    const expectedCalls = (caseItem.expected_calls || []).filter(c => c.turn_index === turnIndex)
    for (const expected of expectedCalls) {
      const output = await harness.executeBenchmarkTool({
        service, cockpitId, calls, turnIndex: expected.turn_index,
        name: expected.name, args: expected.arguments || {},
      })
      assistantMessages.push(output.content || '')
    }
    stateSnapshots.push({ turn_index: turnIndex, state: service.snapshot(cockpitId) })
  }
  return { id: caseItem.id, calls, assistant_messages: assistantMessages, state_snapshots: stateSnapshots, final_state: service.snapshot(cockpitId) }
}

async function main() {
  loadCockpitEnvironment()
  const args = parseArgs(process.argv.slice(2))
  const harness = await import('../runner/controlled-harness.mjs')
  const { COCKPIT_SURFACE_ROUTING } = await import('../../service/tools/registry.mjs')
  const files = args.get('file') ? [String(args.get('file'))] : ALL_FILES
  let cases = []
  for (const file of files) {
    const text = await readFile(new URL(`./${file}`, import.meta.url), 'utf8')
    cases.push(...parseJsonl(text, file))
  }
  cases = routeCasesExpectedPaths(cases, COCKPIT_SURFACE_ROUTING)
  const traces = []
  for (const caseItem of cases) traces.push(await replayCase(caseItem, { harness }))
  const scores = cases.map((caseItem, i) => scoreTrace(caseItem, traces[i]))
  const report = {
    suite: 'smart-cockpit/cockpit-ext', mode: 'gold', files,
    routing: COCKPIT_SURFACE_ROUTING.domains, created_at: new Date().toISOString(),
    summary: summarizeScores(scores), scores, traces,
  }
  const outPath = args.get('out')
  if (outPath) {
    const absolute = resolve(String(outPath))
    await mkdir(dirname(absolute), { recursive: true })
    await writeFile(absolute, `${JSON.stringify(report, null, 2)}\n`)
    console.log(`report: ${absolute}`)
  }
  console.log(JSON.stringify(report.summary, null, 2))
  const failed = scores.filter(s => !s.passed)
  if (failed.length) {
    console.log(`\nFAILED ${failed.length}:`)
    for (const s of failed) console.log(` - ${s.id}: ${JSON.stringify(s).slice(0, 400)}`)
  }
}

main().catch(error => { console.error(error?.stack || error); process.exitCode = 1 })
