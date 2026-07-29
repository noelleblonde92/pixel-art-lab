import fs from 'node:fs/promises'
import { createWriteStream, type WriteStream } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { config } from './config.js'
import type { RunEvent, RunRequest } from './types.js'

export interface Run {
  id: string
  dir: string
  request: RunRequest
  createdAt: number
  /** Set when `run.end` is emitted, so a saved gallery entry can record the real wall clock. */
  finishedAt?: number
  status: 'running' | 'finished'
  controller: AbortController
  /** Every event so far, so a browser that connects late or reconnects sees the whole run. */
  events: RunEvent[]
  subscribers: Set<(event: RunEvent) => void>
  /** The same events appended to `events.jsonl`, so a run survives the server restarting. */
  log: WriteStream
}

const runs = new Map<string, Run>()

export async function createRun(request: RunRequest): Promise<Run> {
  const id = randomUUID().slice(0, 8)
  const dir = path.join(config.runsDir, id)

  await Promise.all(
    ['sprites', 'exports', 'reference', 'tmp'].map((sub) =>
      fs.mkdir(path.join(dir, sub), { recursive: true }),
    ),
  )

  const createdAt = Date.now()
  const log = createWriteStream(path.join(dir, 'events.jsonl'), { flags: 'a' })
  // A header line so the transcript stands alone: which model, which prompt, which settings.
  log.write(JSON.stringify({ t: 'run.request', runId: id, at: createdAt, request }) + '\n')

  const run: Run = {
    id,
    dir,
    request,
    createdAt,
    status: 'running',
    controller: new AbortController(),
    events: [],
    subscribers: new Set(),
    log,
  }

  runs.set(id, run)
  return run
}

export function getRun(id: string): Run | undefined {
  return runs.get(id)
}

export function emitTo(run: Run, event: RunEvent): void {
  run.events.push(event)

  // `atMs` is elapsed run time — deliberately not `ms`, which `tool.result` already uses for its
  // own duration.
  try {
    run.log.write(JSON.stringify({ atMs: Date.now() - run.createdAt, ...event }) + '\n')
  } catch {
    // Logging must never take a run down.
  }

  if (event.t === 'run.end') {
    run.status = 'finished'
    run.finishedAt = Date.now()
    run.log.end()
  }

  for (const subscriber of run.subscribers) {
    try {
      subscriber(event)
    } catch {
      // A dead browser connection must not take the run with it.
    }
  }
}

/**
 * A run reduced to what saving it to the gallery needs.
 *
 * A run outlives the process in `events.jsonl` but only lives in `runs` until the server restarts,
 * so both sources have to produce the same shape — `snapshotRun` for a run this process is still
 * holding, `readRunSnapshot` for one it only has on disk.
 */
export interface RunSnapshot {
  id: string
  dir: string
  request: RunRequest
  events: RunEvent[]
  durationMs: number
}

export function snapshotRun(run: Run): RunSnapshot {
  return {
    id: run.id,
    dir: run.dir,
    request: run.request,
    events: run.events,
    durationMs: (run.finishedAt ?? Date.now()) - run.createdAt,
  }
}

export async function readRunSnapshot(id: string): Promise<RunSnapshot | undefined> {
  const dir = path.join(config.runsDir, id)

  let raw: string
  try {
    raw = await fs.readFile(path.join(dir, 'events.jsonl'), 'utf8')
  } catch {
    return undefined
  }

  let request: RunRequest | undefined
  const events: RunEvent[] = []
  let durationMs = 0

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue // A half-written last line on a crashed run must not lose the rest.
    }

    if (parsed.t === 'run.request') {
      request = parsed.request as RunRequest
      continue
    }

    const { atMs, ...event } = parsed as { atMs?: number } & RunEvent
    if (typeof atMs === 'number') durationMs = Math.max(durationMs, atMs)
    events.push(event as RunEvent)
  }

  return request ? { id, dir, request, events, durationMs } : undefined
}

export function cancelRun(run: Run): void {
  run.controller.abort()
}

/** Keep the runs directory from growing without bound across sessions. */
export async function pruneOldRuns(keep = 40): Promise<void> {
  let entries: string[]
  try {
    entries = await fs.readdir(config.runsDir)
  } catch {
    return
  }

  const dirs = await Promise.all(
    entries.map(async (name) => {
      const full = path.join(config.runsDir, name)
      try {
        const stat = await fs.stat(full)
        return stat.isDirectory() ? { full, mtime: stat.mtimeMs } : null
      } catch {
        return null
      }
    }),
  )

  const sorted = dirs.filter((d): d is { full: string; mtime: number } => d !== null)
    .sort((a, b) => b.mtime - a.mtime)

  for (const stale of sorted.slice(keep)) {
    if (runs.has(path.basename(stale.full))) continue
    await fs.rm(stale.full, { recursive: true, force: true }).catch(() => {})
  }
}
