import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { config } from './config.js'
import { isInside } from './mcp/paths.js'
import type { GalleryEntry, RunEvent, RunRequest, RunStats } from './types.js'
import type { RunSnapshot } from './runs.js'

/**
 * The benchmark gallery.
 *
 * A run workspace is disposable — `pruneOldRuns` deletes it, and the model that drew it may never
 * be run again. Saving *copies* the image, the sprite, the request that produced it and the run's
 * tallies into `gallery/<id>/`, so an entry stays comparable long after its run is gone. Everything
 * a comparison shows comes from that directory alone.
 */

const ID = /^[0-9a-f]{12}$/

export class GalleryError extends Error {}

export function entryDir(id: string): string {
  if (!ID.test(id)) throw new GalleryError(`invalid gallery id "${id}"`)
  return path.join(config.galleryDir, id)
}

/** `image.png` always exists; `sprite.aseprite` only when the run had a sprite to copy. */
export function entryFilePath(id: string, which: 'image' | 'sprite'): string {
  return path.join(entryDir(id), which === 'image' ? 'image.png' : 'sprite.aseprite')
}

export interface SaveRequest {
  /** Path inside the run workspace, e.g. `exports/final.png`. */
  file: string
  spriteFile?: string
  label?: string
  /** The sprite's own size, when the caller knows it — a preview PNG is an enlargement. */
  sourceWidth?: number
  sourceHeight?: number
}

export async function saveEntry(run: RunSnapshot, req: SaveRequest): Promise<GalleryEntry> {
  const image = await readRunFile(run.dir, req.file, ['.png'])
  const sprite = req.spriteFile
    ? await readRunFile(run.dir, req.spriteFile, ['.aseprite']).catch(() => undefined)
    : undefined

  const meta = await sharp(image).metadata().catch(() => undefined)
  const pixelWidth = meta?.width ?? 0
  const pixelHeight = meta?.height ?? 0

  // A preview is the art enlarged N×; the art's own size is what a benchmark compares.
  const width = positive(req.sourceWidth) ?? pixelWidth
  const height = positive(req.sourceHeight) ?? pixelHeight
  const scale = width > 0 && pixelWidth > 0 ? Math.max(1, Math.round(pixelWidth / width)) : 1

  const id = randomUUID().replace(/-/g, '').slice(0, 12)
  const dir = entryDir(id)
  await fs.mkdir(dir, { recursive: true })

  const entry: GalleryEntry = {
    id,
    savedAt: Date.now(),
    label: req.label?.trim() || undefined,
    runId: run.id,
    request: run.request,
    sourceFile: req.file,
    width,
    height,
    scale,
    hasSprite: sprite !== undefined,
    stats: summarizeEvents(run.events, run.durationMs),
  }

  await fs.writeFile(entryFilePath(id, 'image'), image)
  if (sprite) await fs.writeFile(entryFilePath(id, 'sprite'), sprite)
  await writeMeta(entry)

  return entry
}

export async function listEntries(): Promise<GalleryEntry[]> {
  let names: string[]
  try {
    names = await fs.readdir(config.galleryDir)
  } catch {
    return [] // Nothing saved yet.
  }

  const entries = await Promise.all(names.map((name) => readMeta(name).catch(() => undefined)))
  return entries
    .filter((entry): entry is GalleryEntry => entry !== undefined)
    .sort((a, b) => b.savedAt - a.savedAt)
}

export async function getEntry(id: string): Promise<GalleryEntry | undefined> {
  return readMeta(id).catch(() => undefined)
}

export async function updateEntry(
  id: string,
  patch: { label?: string },
): Promise<GalleryEntry | undefined> {
  const entry = await getEntry(id)
  if (!entry) return undefined

  const updated: GalleryEntry = { ...entry, label: patch.label?.trim() || undefined }
  await writeMeta(updated)
  return updated
}

export async function deleteEntry(id: string): Promise<boolean> {
  const dir = entryDir(id)
  try {
    await fs.rm(dir, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

/**
 * Fold a run's events into the numbers a benchmark compares.
 *
 * `usage` arrives once per turn and carries a running cost, while `run.end` carries the final one —
 * prefer that, but fall back to the accumulated total for a run saved mid-flight.
 */
export function summarizeEvents(events: RunEvent[], durationMs: number): RunStats {
  const stats: RunStats = {
    turns: 0,
    iterations: 0,
    toolCalls: 0,
    cost: 0,
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
    durationMs,
  }

  for (const raw of events) {
    const event = fromLegacy(raw)
    switch (event.t) {
      case 'turn.start':
        stats.turns = Math.max(stats.turns, event.n)
        break
      case 'tool.call':
        stats.toolCalls++
        break
      case 'preview':
        stats.iterations++
        break
      case 'usage':
        stats.promptTokens += event.promptTokens
        stats.completionTokens += event.completionTokens
        stats.reasoningTokens += event.reasoningTokens
        stats.cachedTokens += event.cachedTokens
        stats.cost = event.cumulativeCost
        break
      case 'run.end':
        stats.endReason = event.reason
        stats.turns = event.turns || stats.turns
        stats.iterations = event.iterations || stats.iterations
        stats.toolCalls = event.toolCalls || stats.toolCalls
        stats.cost = event.cost || stats.cost
        break
    }
  }

  return stats
}

/**
 * Translate an event logged before turns and iterations were separate counts.
 *
 * Those runs call a turn an iteration — `iteration.start` per round-trip, and a `run.end.iterations`
 * that tallies round-trips rather than preview cycles. `events.jsonl` outlives the code that wrote
 * it, and a gallery entry saved from one of those runs still has to read correctly.
 */
function fromLegacy(event: RunEvent): RunEvent {
  const shape = event as { t: string; n?: number; turns?: number; iterations?: number }

  if (shape.t === 'iteration.start') return { t: 'turn.start', n: shape.n ?? 0 }
  if (shape.t === 'run.end' && shape.turns === undefined) {
    // Leave `iterations` at 0 so the preview count folded from the stream survives.
    return { ...(event as Extract<RunEvent, { t: 'run.end' }>), turns: shape.iterations ?? 0, iterations: 0 }
  }
  return event
}

/** Read a file out of a run workspace, refusing anything that escapes it or is the wrong kind. */
async function readRunFile(runDir: string, relative: string, exts: string[]): Promise<Buffer> {
  const target = path.resolve(runDir, relative)
  if (!isInside(target, runDir)) {
    throw new GalleryError('file is outside the run workspace')
  }
  if (!exts.includes(path.extname(target).toLowerCase())) {
    throw new GalleryError(`file must be one of ${exts.join(', ')}`)
  }

  try {
    return await fs.readFile(target)
  } catch {
    throw new GalleryError(`no such file in the run: ${relative}`)
  }
}

async function readMeta(id: string): Promise<GalleryEntry> {
  const raw = await fs.readFile(path.join(entryDir(id), 'meta.json'), 'utf8')
  return migrateEntry(JSON.parse(raw) as GalleryEntry)
}

/**
 * Read an entry saved before turns and iterations were separate counts.
 *
 * There, `stats.iterations` tallied round-trips and `stats.previews` tallied preview cycles, and
 * `request.maxIterations` capped round-trips — all three names now mean something else. `stats.turns`
 * is the marker for the current shape. Migrating on read rather than rewriting the file keeps the
 * saved record exactly as the run produced it.
 */
export function migrateEntry(entry: GalleryEntry): GalleryEntry {
  if (entry.stats?.turns !== undefined) return entry

  const stats = entry.stats as RunStats & { previews?: number }
  const request = entry.request as RunRequest

  return {
    ...entry,
    request: { ...request, maxTurns: request.maxTurns ?? request.maxIterations, maxIterations: undefined },
    stats: { ...stats, turns: stats.iterations ?? 0, iterations: stats.previews ?? 0 },
  }
}

async function writeMeta(entry: GalleryEntry): Promise<void> {
  await fs.writeFile(
    path.join(entryDir(entry.id), 'meta.json'),
    JSON.stringify(entry, null, 2) + '\n',
  )
}

function positive(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : undefined
}
