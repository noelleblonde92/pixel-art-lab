import express from 'express'
import multer from 'multer'
import fs from 'node:fs/promises'
import path from 'node:path'
import { assertConfigured, config } from './config.js'
import { listModels, getModel } from './openrouter/models.js'
import {
  cancelRun,
  createRun,
  deleteAllRuns,
  emitTo,
  getRun,
  pruneOldRuns,
  readRunSnapshot,
  snapshotRun,
  type Run,
} from './runs.js'
import {
  deleteEntry,
  entryFilePath,
  GalleryError,
  getEntry,
  listEntries,
  saveEntry,
  updateEntry,
} from './gallery.js'
import { exportFinal, runAgent } from './agent/loop.js'
import { toReferenceDataUri } from './lib/images.js'
import { openSse, writeSse, writeSseComment } from './lib/sse.js'
import { isInside } from './mcp/paths.js'
import type { ReasoningEffort, RunEvent, RunRequest, ToolsetName } from './types.js'

assertConfigured()

const app = express()
app.use(express.json({ limit: '2mb' }))

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxReferenceBytes, files: 6 },
})

app.get('/api/models', async (_req, res) => {
  try {
    res.json({ models: await listModels() })
  } catch (err) {
    res.status(502).json({ error: String(err) })
  }
})

app.post('/api/runs', upload.array('reference'), async (req, res) => {
  let request: RunRequest
  try {
    request = parseRunRequest(req.body as Record<string, unknown>)
  } catch (err) {
    res.status(400).json({ error: String(err instanceof Error ? err.message : err) })
    return
  }

  const model = await getModel(request.model).catch(() => undefined)
  if (!model) {
    res.status(400).json({ error: `Unknown model "${request.model}"` })
    return
  }
  if (!model.supportsTools) {
    res.status(400).json({
      error: `${model.id} does not support tool calling, so it cannot drive Aseprite.`,
    })
    return
  }

  const run = await createRun(request)
  const files = (req.files as Express.Multer.File[] | undefined) ?? []

  const referenceFiles: string[] = []
  const referenceDataUris: string[] = []
  for (const [i, file] of files.entries()) {
    const safeName = `ref-${i + 1}${path.extname(file.originalname).toLowerCase() || '.png'}`
    const dest = path.join(run.dir, 'reference', safeName)
    await fs.writeFile(dest, file.buffer)
    referenceFiles.push(dest)
    try {
      referenceDataUris.push(await toReferenceDataUri(file.buffer))
    } catch {
      // A reference we cannot re-encode still exists on disk for analyze_reference.
    }
  }

  res.json({ runId: run.id })

  void start(run, model, referenceFiles, referenceDataUris)
  void pruneOldRuns()
})

async function start(
  run: Run,
  model: Awaited<ReturnType<typeof getModel>> & object,
  referenceFiles: string[],
  referenceDataUris: string[],
): Promise<void> {
  const emit = (event: RunEvent) => emitTo(run, event)

  try {
    const outcome = await runAgent({
      runId: run.id,
      runDir: run.dir,
      request: run.request,
      model,
      referenceFiles,
      referenceDataUris,
      signal: run.controller.signal,
      emit,
    })

    const finalPng = await exportFinal(run.dir, outcome.finalSprite)

    emit({
      t: 'run.end',
      reason: outcome.reason,
      turns: outcome.turns,
      iterations: outcome.iterations,
      toolCalls: outcome.toolCalls,
      cost: outcome.cost,
      finalSprite: outcome.finalSprite,
      finalPng,
      message: outcome.message,
    })
  } catch (err) {
    emit({
      t: 'run.end',
      reason: 'error',
      turns: 0,
      iterations: 0,
      toolCalls: 0,
      cost: 0,
      message: String(err instanceof Error ? err.message : err),
    })
  }
}

/**
 * Clear out the run workspaces.
 *
 * Starting a run already prunes the oldest, so this is for the session that wants the whole
 * directory back. A run still in flight survives it — see `deleteAllRuns`.
 */
app.delete('/api/runs', async (_req, res) => {
  try {
    res.json(await deleteAllRuns())
  } catch (err) {
    res.status(500).json({ error: String(err instanceof Error ? err.message : err) })
  }
})

app.get('/api/runs/:id/events', (req, res) => {
  const run = getRun(req.params.id)
  if (!run) {
    res.status(404).json({ error: 'no such run' })
    return
  }

  openSse(res)

  // Replay first so a browser that connects a moment late still sees the whole run.
  for (const event of run.events) writeSse(res, event)

  if (run.status === 'finished') {
    res.end()
    return
  }

  const subscriber = (event: RunEvent) => {
    writeSse(res, event)
    if (event.t === 'run.end') res.end()
  }
  run.subscribers.add(subscriber)

  // Proxies drop idle streams; a comment every 15s keeps the connection alive.
  const heartbeat = setInterval(() => writeSseComment(res, 'ping'), 15_000)

  req.on('close', () => {
    clearInterval(heartbeat)
    run.subscribers.delete(subscriber)
  })
})

app.post('/api/runs/:id/cancel', (req, res) => {
  const run = getRun(req.params.id)
  if (!run) {
    res.status(404).json({ error: 'no such run' })
    return
  }
  cancelRun(run)
  res.json({ ok: true })
})

app.get('/api/runs/:id/files/*', async (req, res) => {
  const run = getRun(req.params.id)
  if (!run) {
    res.status(404).json({ error: 'no such run' })
    return
  }

  const relative = (req.params as unknown as Record<string, string>)[0] ?? ''
  const target = path.resolve(run.dir, relative)
  if (!isInside(target, run.dir)) {
    res.status(403).json({ error: 'path outside the run workspace' })
    return
  }

  res.sendFile(target, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'not found' })
  })
})

app.get('/api/gallery', async (_req, res) => {
  res.json({ entries: await listEntries() })
})

/**
 * Save an image out of a run.
 *
 * The run is the source of truth for everything except the image itself, so the browser only says
 * *which* file it wants kept — the model, the prompt and the tallies are read back off the run,
 * whether it is still in memory or only in `events.jsonl`.
 */
app.post('/api/gallery', async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>
  const runId = String(body.runId ?? '').trim()
  const file = String(body.file ?? '').trim()

  if (!runId || !file) {
    res.status(400).json({ error: 'runId and file are required' })
    return
  }

  const live = getRun(runId)
  const snapshot = live ? snapshotRun(live) : await readRunSnapshot(runId)
  if (!snapshot) {
    res.status(404).json({ error: 'no such run' })
    return
  }

  try {
    const entry = await saveEntry(snapshot, {
      file,
      spriteFile: optionalString(body.spriteFile),
      label: optionalString(body.label),
      sourceWidth: optionalPositiveInt(body.sourceWidth),
      sourceHeight: optionalPositiveInt(body.sourceHeight),
    })
    res.json({ entry })
  } catch (err) {
    const status = err instanceof GalleryError ? 400 : 500
    res.status(status).json({ error: String(err instanceof Error ? err.message : err) })
  }
})

app.patch('/api/gallery/:id', async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>
  try {
    const entry = await updateEntry(req.params.id, { label: optionalString(body.label) })
    if (!entry) {
      res.status(404).json({ error: 'no such entry' })
      return
    }
    res.json({ entry })
  } catch (err) {
    res.status(400).json({ error: String(err instanceof Error ? err.message : err) })
  }
})

app.delete('/api/gallery/:id', async (req, res) => {
  try {
    res.json({ ok: await deleteEntry(req.params.id) })
  } catch (err) {
    res.status(400).json({ error: String(err instanceof Error ? err.message : err) })
  }
})

app.get('/api/gallery/:id/:which(image|sprite)', async (req, res) => {
  const which = req.params.which as 'image' | 'sprite'

  let target: string
  try {
    target = entryFilePath(req.params.id, which)
  } catch {
    res.status(400).json({ error: 'invalid gallery id' })
    return
  }

  const entry = await getEntry(req.params.id)
  if (!entry || (which === 'sprite' && !entry.hasSprite)) {
    res.status(404).json({ error: 'not found' })
    return
  }

  res.sendFile(target, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'not found' })
  })
})

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, mcpBin: config.mcpBin, runsDir: config.runsDir })
})

app.listen(config.port, () => {
  console.log(`pixel-art-lab server on http://localhost:${config.port}`)
  console.log(`  pixel-mcp: ${config.mcpBin}`)
  console.log(`  runs:      ${config.runsDir}`)
})

function parseRunRequest(body: Record<string, unknown>): RunRequest {
  const prompt = String(body.prompt ?? '').trim()
  if (!prompt) throw new Error('prompt is required')

  const model = String(body.model ?? '').trim()
  if (!model) throw new Error('model is required')

  const effort = body.reasoningEffort ? String(body.reasoningEffort) : undefined
  const toolset = body.toolset ? String(body.toolset) : undefined

  return {
    prompt,
    model,
    width: optionalPositiveInt(body.width),
    height: optionalPositiveInt(body.height),
    aspectRatio: optionalString(body.aspectRatio),
    maxTurns: optionalPositiveInt(body.maxTurns),
    maxIterations: optionalPositiveInt(body.maxIterations),
    maxCostUsd: optionalPositiveNumber(body.maxCostUsd),
    reasoningEffort: isEffort(effort) ? effort : undefined,
    toolset: toolset === 'full' || toolset === 'core' ? (toolset as ToolsetName) : 'core',
  }
}

function optionalPositiveInt(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const n = Math.trunc(Number(value))
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/** Money, so fractional — `$0.05` is a perfectly reasonable cap on a small run. */
function optionalPositiveNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  const s = String(value).trim()
  return s || undefined
}

function isEffort(value: string | undefined): value is ReasoningEffort {
  return (
    value === 'none' ||
    value === 'minimal' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh'
  )
}
