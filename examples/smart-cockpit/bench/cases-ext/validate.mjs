// DriveVoice Agent Lab (Project 2) extension-suite validator.
// Reuses the upstream evaluator + tool registry so extension cases are held to
// exactly the same schema rules as the official benchmark cases.
// Run from examples/smart-cockpit:  node bench/cases-ext/validate.mjs
import { readFileSync } from 'node:fs'
import { parseJsonl, assertBenchmarkCase, routeCasesExpectedPaths } from '../evaluator/cases.mjs'
import { COCKPIT_TOOL_NAMES, COCKPIT_SURFACE_ROUTING, surfaceForCockpitTool } from '../../service/tools/registry.mjs'

const benchmarkToolNames = new Set(
  COCKPIT_TOOL_NAMES.filter(name => (
    name === 'weather'
    || name.startsWith('vehicle_')
    || name.startsWith('music_')
    || name.startsWith('navigation_')
  )),
)

const FILES = [
  'interruption-correction.jsonl',
  'asr-noise.jsonl',
  'safety-confirmation.jsonl',
  'fuzzy-multi-intent.jsonl',
]

let total = 0
const allIds = new Set()
for (const file of FILES) {
  const url = new URL(`./${file}`, import.meta.url)
  const raw = parseJsonl(readFileSync(url, 'utf8'), file)
  const cases = routeCasesExpectedPaths(raw, COCKPIT_SURFACE_ROUTING)
  for (const caseItem of cases) {
    assertBenchmarkCase(caseItem, { toolNames: benchmarkToolNames, surfaceForTool: surfaceForCockpitTool })
    if (allIds.has(caseItem.id)) throw new Error(`duplicate case id: ${caseItem.id}`)
    allIds.add(caseItem.id)
  }
  const turns = cases.reduce((n, c) => n + c.turns.length, 0)
  const calls = cases.reduce((n, c) => n + c.expected_calls.length, 0)
  console.log(`OK ${file}: ${cases.length} cases, ${turns} turns, ${calls} expected calls`)
  total += cases.length
}
console.log(`\nAll extension suites valid: ${total} cases, ids unique.`)
