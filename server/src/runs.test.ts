import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * `config` reads `RUNS_DIR` at import time, so the temp workspace has to exist and be exported
 * before anything pulls `runs.ts` in — hence the dynamic import below.
 */
const runsDir = path.join(os.tmpdir(), `pal-runs-test-${process.pid}`)
process.env.RUNS_DIR = runsDir

const { createRun, deleteAllRuns, emitTo, getRun } = await import('./runs.js')

const request = { prompt: 'a cat', model: 'test/model', toolset: 'core' as const }

beforeAll(async () => {
  await fs.mkdir(runsDir, { recursive: true })
})

afterAll(async () => {
  await fs.rm(runsDir, { recursive: true, force: true })
})

describe('deleteAllRuns', () => {
  it('deletes workspaces this process never started', async () => {
    await fs.mkdir(path.join(runsDir, 'old-run', 'sprites'), { recursive: true })
    await fs.writeFile(path.join(runsDir, 'stray.txt'), 'not a run')

    expect(await deleteAllRuns()).toEqual({ removed: 1, skipped: 0 })
    expect(await fs.readdir(runsDir)).toEqual(['stray.txt'])
  })

  it('leaves a run that is still going, and takes it once it finishes', async () => {
    const run = await createRun(request)

    // A live run is still writing its events.jsonl; deleting it would break the run and the record.
    expect(await deleteAllRuns()).toEqual({ removed: 0, skipped: 1 })
    expect(await fs.readdir(runsDir)).toContain(run.id)

    emitTo(run, { t: 'run.end', reason: 'done', turns: 1, iterations: 0, toolCalls: 0, cost: 0 })

    expect(await deleteAllRuns()).toEqual({ removed: 1, skipped: 0 })
    expect(await fs.readdir(runsDir)).not.toContain(run.id)
    // Dropped from the map too, so nothing is left pointing at a workspace that is gone.
    expect(getRun(run.id)).toBeUndefined()
  })
})
