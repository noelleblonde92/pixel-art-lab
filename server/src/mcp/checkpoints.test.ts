import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Checkpoints } from './checkpoints.js'

let runDir: string
let sprite: string

beforeEach(async () => {
  runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pal-checkpoints-'))
  await fs.mkdir(path.join(runDir, 'sprites'), { recursive: true })
  sprite = path.join(runDir, 'sprites', 'knight.aseprite')
})

afterEach(async () => {
  await fs.rm(runDir, { recursive: true, force: true })
})

/** pixel-mcp writes the whole sprite on every call, so a drawing edit is just different bytes. */
const draw = (content: string) => fs.writeFile(sprite, content)
const read = () => fs.readFile(sprite, 'utf8')

const restored = (result: unknown) => (result as { restored_to_iteration?: number }).restored_to_iteration

describe('Checkpoints', () => {
  it('restores the state of the last preview', async () => {
    const cp = new Checkpoints(runDir)
    await draw('silhouette')
    await cp.capture(sprite, 1)

    await draw('silhouette + a bad hat')
    const res = await cp.restore(sprite)

    expect(res.ok).toBe(true)
    expect(restored(res.result)).toBe(1)
    expect(await read()).toBe('silhouette')
  })

  it('reports there is nothing to undo before the first preview', async () => {
    const cp = new Checkpoints(runDir)
    await draw('silhouette')

    const res = await cp.restore(sprite)
    expect(res.ok).toBe(false)
    expect(String((res.result as { error: string }).error)).toMatch(/no preview/i)
  })

  /**
   * The case a naive stack gets wrong: the newest checkpoint *is* the current state, so restoring it
   * would report success and change nothing. A second undo has to keep walking backwards.
   */
  it('steps further back when the sprite is unchanged since the last preview', async () => {
    const cp = new Checkpoints(runDir)
    await draw('silhouette')
    await cp.capture(sprite, 1)
    await draw('shading')
    await cp.capture(sprite, 2)

    const first = await cp.restore(sprite)
    expect(restored(first.result)).toBe(1)
    expect(await read()).toBe('silhouette')

    // Nothing drawn in between, so this is a second undo — and there is nothing older to reach.
    const second = await cp.restore(sprite)
    expect(second.ok).toBe(false)
    expect(String((second.result as { error: string }).error)).toMatch(/oldest restore point/i)
  })

  it('undoes only the newest round when edits follow a preview', async () => {
    const cp = new Checkpoints(runDir)
    await draw('a')
    await cp.capture(sprite, 1)
    await draw('b')
    await cp.capture(sprite, 2)
    await draw('c')

    expect(restored((await cp.restore(sprite)).result)).toBe(2)
    expect(await read()).toBe('b')
    expect(restored((await cp.restore(sprite)).result)).toBe(1)
    expect(await read()).toBe('a')
  })

  it('jumps to an explicit earlier iteration', async () => {
    const cp = new Checkpoints(runDir)
    await draw('a')
    await cp.capture(sprite, 1)
    await draw('b')
    await cp.capture(sprite, 2)
    await draw('c')
    await cp.capture(sprite, 3)

    const res = await cp.restore(sprite, 1)
    expect(res.ok).toBe(true)
    expect(await read()).toBe('a')
    expect((res.result as { discarded_restore_points: number }).discarded_restore_points).toBe(2)
  })

  it('lists what is available when the asked-for iteration is gone', async () => {
    const cp = new Checkpoints(runDir)
    await draw('a')
    await cp.capture(sprite, 1)

    const res = await cp.restore(sprite, 7)
    expect(res.ok).toBe(false)
    expect(String((res.result as { error: string }).error)).toMatch(/Available: 1\./)
  })

  /**
   * Restoring truncates, so work built on top of an earlier checkpoint cannot undo *forwards* into
   * the branch that was thrown away — which is the state the model had already rejected.
   */
  it('does not undo into a branch that was already discarded', async () => {
    const cp = new Checkpoints(runDir)
    await draw('a')
    await cp.capture(sprite, 1)
    await draw('bad')
    await cp.capture(sprite, 2)

    await draw('bad + worse')
    await cp.restore(sprite) // back to 'bad'
    await cp.restore(sprite) // back to 'a'
    expect(await read()).toBe('a')

    await draw('a + good')
    await cp.capture(sprite, 3)
    await draw('a + good + tweak')

    const res = await cp.restore(sprite)
    expect(restored(res.result)).toBe(3)
    expect(await read()).toBe('a + good')
  })

  it('keeps a separate history per sprite', async () => {
    const cp = new Checkpoints(runDir)
    const other = path.join(runDir, 'sprites', 'tree.aseprite')

    await draw('knight v1')
    await cp.capture(sprite, 1)
    await fs.writeFile(other, 'tree v1')
    await cp.capture(other, 2)

    await draw('knight v2')
    await fs.writeFile(other, 'tree v2')

    expect(restored((await cp.restore(other)).result)).toBe(2)
    expect(await fs.readFile(other, 'utf8')).toBe('tree v1')
    expect(await read()).toBe('knight v2')

    expect(restored((await cp.restore(sprite)).result)).toBe(1)
    expect(await read()).toBe('knight v1')
  })

  it('recovers a sprite that was deleted outright', async () => {
    const cp = new Checkpoints(runDir)
    await draw('a')
    await cp.capture(sprite, 1)
    await fs.rm(sprite)

    const res = await cp.restore(sprite)
    expect(res.ok).toBe(true)
    expect(await read()).toBe('a')
  })
})
