/**
 * Render a run's `events.jsonl` as a readable transcript — what the model said, what it called,
 * what came back, and where it burned its budget. This is the thing to paste into a chat when
 * asking "why did this run go wrong?".
 *
 * Usage:
 *   node server/scripts/transcript.mjs            # the most recent run
 *   node server/scripts/transcript.mjs <runId>
 *   node server/scripts/transcript.mjs <runId> --full      # no truncation of args/results
 *   node server/scripts/transcript.mjs <runId> --reasoning # include reasoning deltas
 *   node server/scripts/transcript.mjs --list              # list runs, newest first
 *
 * RUNS_DIR overrides where runs live (matching server/src/config.ts).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('../../', import.meta.url))
const runsDir = path.resolve(process.env.RUNS_DIR ?? path.join(projectRoot, 'runs'))

const args = process.argv.slice(2)
const flags = new Set(args.filter((a) => a.startsWith('--')))
const wanted = args.find((a) => !a.startsWith('--'))
const full = flags.has('--full')
const showReasoning = flags.has('--reasoning')
const LIMIT = full ? Infinity : 700

const runIds = fs
  .readdirSync(runsDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => ({ id: e.name, mtime: fs.statSync(path.join(runsDir, e.name)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime)
  .map((e) => e.id)

if (flags.has('--list')) {
  for (const id of runIds) {
    const meta = readMeta(id)
    console.log(`${id}  ${meta?.request?.model ?? '?'}  ${truncate(meta?.request?.prompt ?? '', 60)}`)
  }
  process.exit(0)
}

const runId = wanted ?? runIds[0]
if (!runId) {
  console.error(`no runs under ${runsDir}`)
  process.exit(1)
}

const file = path.join(runsDir, runId, 'events.jsonl')
if (!fs.existsSync(file)) {
  console.error(`${file} does not exist — the run predates event logging, or never started.`)
  process.exit(1)
}

const events = fs
  .readFileSync(file, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    try {
      return JSON.parse(line)
    } catch {
      return null
    }
  })
  .filter(Boolean)

const calls = new Map() // tool call id -> name, for pairing results back onto calls
let text = ''
let reasoning = ''
let iterations = 0 // preview cycles — the model looking at its own work

for (const e of events) {
  // Deltas arrive token by token; flush the buffered ones whenever something else happens.
  if (e.t !== 'text.delta') flushText()
  if (e.t !== 'reasoning.delta') flushReasoning()

  switch (e.t) {
    case 'run.request':
      console.log(`# run ${e.runId}`)
      console.log(`model:  ${e.request.model}`)
      console.log(`prompt: ${e.request.prompt}`)
      console.log(
        `size:   ${e.request.width ?? '?'}x${e.request.height ?? '?'}` +
          `   turns: ${e.request.maxTurns ?? e.request.maxIterations ?? 'default'}` +
          `   iterations: ${e.request.maxTurns ? (e.request.maxIterations ?? 'uncapped') : 'uncapped'}` +
          `   cost cap: ${e.request.maxCostUsd ? `$${e.request.maxCostUsd}` : 'none'}` +
          `   effort: ${e.request.reasoningEffort ?? 'default'}` +
          `   toolset: ${e.request.toolset ?? 'core'}`,
      )
      break

    case 'run.start':
      console.log(`tools:  ${e.toolCount} exposed`)
      break

    // `iteration.start` is what runs recorded before turns and iterations were separate counts
    // called a round-trip. There, an iteration *was* a turn.
    case 'turn.start':
    case 'iteration.start':
      console.log(`\n${'='.repeat(70)}\n== turn ${e.n}${stamp(e)}\n`)
      break

    case 'text.delta':
      text += e.text
      break

    case 'reasoning.delta':
      reasoning += e.text
      break

    case 'tool.call':
      calls.set(e.id, e.name)
      console.log(`  → ${e.name}(${truncate(compact(e.args), LIMIT)})`)
      break

    case 'tool.result':
      console.log(
        `  ${e.ok ? '←' : '✗'} ${e.name} [${e.ms}ms] ${truncate(compact(e.result), LIMIT)}`,
      )
      break

    case 'preview':
      iterations++
      console.log(
        `  🖼  iteration ${iterations}: ${e.spritePath} ${e.width}x${e.height} @${e.scale}x` +
          `${e.note ? ` (${e.note})` : ''}  →  runs/${runId}/exports/${path.basename(e.url)}`,
      )
      break

    case 'usage':
      console.log(
        `  · tokens in ${e.promptTokens} / out ${e.completionTokens}` +
          `${e.reasoningTokens ? ` (reasoning ${e.reasoningTokens})` : ''}` +
          `${e.cachedTokens ? ` [cached ${e.cachedTokens}]` : ''}` +
          `${e.cacheWriteTokens ? ` [cache write ${e.cacheWriteTokens}]` : ''}` +
          `  cost $${e.cost.toFixed(4)} (run $${e.cumulativeCost.toFixed(4)})`,
      )
      break

    case 'warning':
      console.log(`  ⚠  ${e.message}`)
      break

    case 'run.end':
      console.log(`\n${'='.repeat(70)}`)
      console.log(
        `end: ${e.reason} — ${e.turns ?? e.iterations} turns, ` +
          `${e.turns === undefined ? iterations : e.iterations} iterations, ` +
          `${e.toolCalls} tool calls, $${e.cost.toFixed(4)}`,
      )
      if (e.message) console.log(`     ${e.message}`)
      if (e.finalSprite) console.log(`     sprite: ${e.finalSprite}`)
      if (e.finalPng) console.log(`     png:    runs/${runId}/exports/${path.basename(e.finalPng)}`)
      break
  }
}

flushText()
flushReasoning()

if (!events.some((e) => e.t === 'run.end')) {
  console.log(`\n(no run.end — this run is still going, or the server died mid-run)`)
}

function flushText() {
  if (!text.trim()) return (text = '')
  console.log(indent(text.trim()))
  text = ''
}

function flushReasoning() {
  if (!reasoning.trim()) return (reasoning = '')
  if (showReasoning) console.log(indent(`[reasoning] ${reasoning.trim()}`))
  reasoning = ''
}

function indent(s) {
  return s
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n')
}

function compact(value) {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function truncate(s, limit = 80) {
  if (s.length <= limit) return s
  return `${s.slice(0, limit)}… (+${s.length - limit} chars, --full to see)`
}

function stamp(e) {
  return typeof e.atMs === 'number' ? `  (+${(e.atMs / 1000).toFixed(1)}s)` : ''
}

function readMeta(id) {
  try {
    const first = fs.readFileSync(path.join(runsDir, id, 'events.jsonl'), 'utf8').split('\n')[0]
    return JSON.parse(first)
  } catch {
    return null
  }
}
