/**
 * End-to-end smoke test: start a real run against a real model and assert it produced art.
 *
 * Usage: node scripts/smoke.mjs [model] [prompt]
 * Requires the server to already be running on :8787.
 */
const BASE = process.env.PAL_BASE ?? 'http://localhost:8787'
const model = process.argv[2] ?? 'qwen/qwen3.7-flash'
const prompt = process.argv[3] ?? 'A red mushroom with white spots, front view, on a transparent background'

const form = new FormData()
form.append('prompt', prompt)
form.append('model', model)
form.append('width', process.env.W ?? '16')
form.append('height', process.env.H ?? '16')
form.append('maxTurns', process.env.TURNS ?? '12')
if (process.env.ITERS) form.append('maxIterations', process.env.ITERS)
if (process.env.MAX_COST) form.append('maxCostUsd', process.env.MAX_COST)
form.append('reasoningEffort', process.env.EFFORT ?? 'low')

const started = await fetch(`${BASE}/api/runs`, { method: 'POST', body: form })
const body = await started.json()
if (!started.ok) {
  console.error('start failed:', body)
  process.exit(1)
}
const runId = body.runId
console.log(`run ${runId} — ${model}\n`)

const res = await fetch(`${BASE}/api/runs/${runId}/events`)
const reader = res.body.getReader()
const decoder = new TextDecoder()

let buffer = ''
let previews = 0
let toolCalls = 0
let toolErrors = 0
let end = null
const toolNames = new Map()

outer: while (true) {
  const { done, value } = await reader.read()
  if (done) break
  buffer += decoder.decode(value, { stream: true })

  let sep
  while ((sep = buffer.indexOf('\n\n')) !== -1) {
    const frame = buffer.slice(0, sep)
    buffer = buffer.slice(sep + 2)
    if (!frame.startsWith('data:')) continue

    const event = JSON.parse(frame.slice(5).trim())
    switch (event.t) {
      case 'run.start':
        console.log(
          `  tools exposed: ${event.toolCount}, max turns: ${event.maxTurns}` +
            `, max iterations: ${event.maxIterations ?? 'uncapped'}` +
            `, max cost: ${event.maxCostUsd ? `$${event.maxCostUsd}` : 'uncapped'}`,
        )
        break
      case 'turn.start':
        process.stdout.write(`\n[${event.n}] `)
        break
      case 'tool.call':
        toolCalls++
        toolNames.set(event.name, (toolNames.get(event.name) ?? 0) + 1)
        process.stdout.write(`${event.name} `)
        break
      case 'tool.result':
        if (!event.ok) {
          toolErrors++
          process.stdout.write(`\n    ERROR ${event.name}: ${JSON.stringify(event.result).slice(0, 200)}\n`)
        }
        break
      case 'preview':
        previews++
        process.stdout.write(`\n    PREVIEW ${event.width}x${event.height}@${event.scale}x ${event.note ?? ''}\n`)
        break
      case 'warning':
        process.stdout.write(`\n    WARN ${event.message}\n`)
        break
      case 'usage':
        break
      case 'run.end':
        end = event
        break outer
    }
  }
}

console.log('\n\n--- outcome ---')
console.log(JSON.stringify(end, null, 2))
console.log('\ntool usage:', [...toolNames.entries()].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n}x${c}`).join(', '))

const failures = []
if (!end) failures.push('no run.end event')
if (end && end.reason === 'error') failures.push(`run failed: ${end.message}`)
if (previews === 0) failures.push('never rendered a preview')
if (!end?.finalSprite) failures.push('no final sprite')
if (!end?.finalPng) failures.push('no final PNG')

console.log(`\npreviews=${previews} toolCalls=${toolCalls} toolErrors=${toolErrors}`)
if (failures.length) {
  console.error('\nFAILED:\n  ' + failures.join('\n  '))
  process.exit(1)
}
console.log('\nPASS')
