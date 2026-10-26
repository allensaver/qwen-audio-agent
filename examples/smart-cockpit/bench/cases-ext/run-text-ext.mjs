// DriveVoice Agent Lab (Project 2 · R2): text-model runner for extension suites.
// Mirrors upstream bench/runner/run-text.mjs (same harness, prompt, tool
// execution and scorer); the only change is that cases load from cases-ext/.
// Run from repo root with DASHSCOPE_API_KEY in env:
//   node examples/smart-cockpit/bench/cases-ext/run-text-ext.mjs --model qwen3.8-flash --out <report.json> [--file <suite.jsonl>] [--concurrency 4]
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { DashScopeCockpitModel } from '../../agent/model.mjs'
import { loadCockpitEnvironment } from '../../bootstrap/environment.mjs'
import { parseJsonl, routeCasesExpectedPaths } from '../evaluator/cases.mjs'
import { scoreTrace, summarizeScores } from '../evaluator/score.mjs'

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000
const ALL_FILES = [
  'interruption-correction.jsonl',
  'asr-noise.jsonl',
  'safety-confirmation.jsonl',
  'fuzzy-multi-intent.jsonl',
]

async function completeWithTimeout(model, request, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await model.complete({ ...request, signal: controller.signal })
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`Model request timed out after ${timeoutMs}ms`)
    throw error
  } finally { clearTimeout(timer) }
}

async function runCase(caseItem, { model, harness, domains, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS }) {
  const service = harness.createBenchmarkService()
  const cockpitId = caseItem.id
  await harness.setupBenchmarkCase(caseItem, { service, cockpitId })
  // DriveVoice fork change: single-domain cases only expose that domain's
  // tools/prompt (the harness supports domain subsets natively). This cuts the
  // tool-schema tokens resent on every model round. Mixed cases keep all domains.
  const caseDomains = caseItem.domain === 'mixed' ? domains : [caseItem.domain]
  const tools = harness.benchmarkTools({ domains: caseDomains })
  // DriveVoice fork change (R4): EXT_SYSTEM_SUFFIX appends an extra system
  // instruction (e.g. the R5 safety-confirmation protocol) for ablation runs.
  // Recorded verbatim in the report metadata; unset = upstream behavior.
  const systemSuffix = process.env.EXT_SYSTEM_SUFFIX || ''
  const basePrompt = harness.cockpitBenchmarkPrompt({ domains: caseDomains })
  const messages = [{ role: 'system', content: systemSuffix ? `${basePrompt}\n\n${systemSuffix}` : basePrompt }]
  const calls = []
  const assistantMessages = []
  const stateSnapshots = []
  try {
    for (const [turnIndex, turn] of caseItem.turns.entries()) {
      messages.push({ role: 'user', content: turn.user })
      for (let round = 0; round < harness.MAX_MODEL_ROUNDS_PER_TURN; round += 1) {
        const message = await completeWithTimeout(model, { messages, tools }, requestTimeoutMs)
        const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
        if (!toolCalls.length) {
          const content = String(message.content || '').trim()
          if (content) assistantMessages.push(content)
          messages.push({ role: 'assistant', content: content || '好的' })
          break
        }
        messages.push({ role: 'assistant', content: message.content || null, tool_calls: toolCalls })
        for (const toolCall of toolCalls) {
          const name = String(toolCall?.function?.name || '')
          const args = harness.parseToolArguments(toolCall)
          let content = '座舱操作已完成'
          try {
            const output = await harness.executeBenchmarkTool({ service, cockpitId, calls, turnIndex, name, args })
            content = output.content || content
          } catch (error) {
            content = `工具调用失败：${error.message || String(error)}`
          }
          messages.push({ role: 'tool', tool_call_id: toolCall.id, content })
        }
        if (round === harness.MAX_MODEL_ROUNDS_PER_TURN - 1) {
          assistantMessages.push('模型在本轮超过最大工具调用轮数')
        }
      }
      stateSnapshots.push({ turn_index: turnIndex, state: service.snapshot(cockpitId) })
    }
  } catch (error) {
    assistantMessages.push(`BENCHMARK_ERROR: ${error.message || String(error)}`)
    return { id: caseItem.id, calls, assistant_messages: assistantMessages, state_snapshots: stateSnapshots, error: { message: error.message || String(error) }, final_state: service.snapshot(cockpitId) }
  }
  return { id: caseItem.id, calls, assistant_messages: assistantMessages, state_snapshots: stateSnapshots, final_state: service.snapshot(cockpitId) }
}

async function main() {
  loadCockpitEnvironment()
  const harness = await import('../runner/controlled-harness.mjs')
  const { COCKPIT_SURFACE_ROUTING } = await import('../../service/tools/registry.mjs')
  const args = harness.parseRunnerArgs(process.argv.slice(2))
  const files = args.get('file') ? [String(args.get('file'))] : ALL_FILES
  const domains = harness.BENCHMARK_DOMAINS
  const requestTimeoutMs = harness.numberArg(args, 'request-timeout-ms', DEFAULT_REQUEST_TIMEOUT_MS)
  const outPath = args.get('out') || 'examples/smart-cockpit/bench/reports/ext-text-latest.json'
  const model = new DashScopeCockpitModel({ model: args.get('model') || process.env.DASHSCOPE_MODEL })
  let cases = []
  for (const file of files) {
    const text = await readFile(new URL(`./${file}`, import.meta.url), 'utf8')
    cases.push(...parseJsonl(text, file))
  }
  cases = routeCasesExpectedPaths(cases, COCKPIT_SURFACE_ROUTING)
  const caseId = args.get('case-id')
  if (caseId) cases = cases.filter(item => item.id === caseId)
  const limit = Number(args.get('limit') || 0)
  if (limit > 0) cases = cases.slice(0, limit)
  if (!cases.length) throw new Error('No extension cases selected')

  const traces = new Array(cases.length)
  const concurrency = Math.min(cases.length, Math.max(1, Number(args.get('concurrency') || 1)))
  let nextCase = 0
  async function worker() {
    while (nextCase < cases.length) {
      const index = nextCase; nextCase += 1
      process.stderr.write(`[${index + 1}/${cases.length}] ${cases[index].id}\n`)
      traces[index] = await runCase(cases[index], { model, harness, domains, requestTimeoutMs })
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  const scores = cases.map((caseItem, i) => scoreTrace(caseItem, traces[i]))
  const report = {
    suite: 'smart-cockpit/cockpit-ext', mode: 'text', files, domains,
    model: model.model, enable_thinking: process.env.BENCH_ENABLE_THINKING !== 'off',
    system_suffix: process.env.EXT_SYSTEM_SUFFIX || null,
    tool_scope: 'per-case domain (mixed cases use all domains)',
    request_timeout_ms: requestTimeoutMs, concurrency,
    routing: COCKPIT_SURFACE_ROUTING.domains, created_at: new Date().toISOString(),
    summary: summarizeScores(scores), scores, traces,
  }
  const absolute = resolve(String(outPath))
  await mkdir(dirname(absolute), { recursive: true })
  await writeFile(absolute, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify(report.summary, null, 2))
  console.log(`report: ${absolute}`)
}

main().catch(error => { console.error(error?.stack || error); process.exitCode = 1 })
