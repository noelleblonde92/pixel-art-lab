import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Snapshots of the sprite, one per preview the model got to look at.
 *
 * pixel-mcp is stateless — every tool call reopens the `.aseprite` from disk, mutates it and saves it
 * back — so the file *is* the whole state, and copying it captures layers, frames, palette and tags
 * exactly. There is nothing to ask Aseprite for and no undo history to keep in step with.
 *
 * The preview is the checkpoint because it is the only moment the model has actually judged the work:
 * "put it back how it was" is only meaningful about a state someone looked at. It also means the image
 * describing the restored state is already in the model's context, so an undo needs no explanation
 * beyond the iteration number.
 */
export interface Checkpoint {
  /** The preview iteration this is the state of — the number the model read in its `budget` line. */
  iteration: number
  /** Where the snapshot lives, under `tmp/checkpoints/`. */
  file: string
  hash: string
}

export interface RestoreOutcome {
  ok: boolean
  /** The tool result the model reads. */
  result: unknown
  /** The iteration restored to. The caller drops the preview images taken after it. */
  restoredTo?: number
}

export class Checkpoints {
  private readonly dir: string
  /** Keyed by absolute sprite path: a run may hold more than one sprite, each with its own history. */
  private readonly stacks = new Map<string, Checkpoint[]>()
  private seq = 0

  constructor(runDir: string) {
    this.dir = path.join(runDir, 'tmp', 'checkpoints')
  }

  /**
   * Snapshot the sprite as it stands. Called once per successful preview.
   *
   * The filename is a running counter rather than the iteration number, because a restore truncates
   * the stack and later previews carry on counting — reusing a number would overwrite a live snapshot.
   */
  async capture(spritePath: string, iteration: number): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true })
    const file = path.join(this.dir, `${++this.seq}.aseprite`)
    await fs.copyFile(spritePath, file)

    const stack = this.stacks.get(spritePath) ?? []
    stack.push({ iteration, file, hash: await hashFile(file) })
    this.stacks.set(spritePath, stack)
  }

  /**
   * Put the sprite back to a checkpoint, and report which one in the model's own units.
   *
   * With no `iteration`, "undo" means the most recent state the model saw that is not the state it is
   * already in — so the newest checkpoint is skipped when the sprite is untouched since it was taken.
   * That is what makes a second `undo` keep walking backwards instead of restoring the same bytes
   * twice and looking like it did nothing.
   */
  async restore(spritePath: string, iteration?: number): Promise<RestoreOutcome> {
    const stack = this.stacks.get(spritePath) ?? []

    if (stack.length === 0) {
      return fail(
        'Nothing to undo: no preview of this sprite has been rendered yet. Every `render_preview` ' +
          'becomes a restore point, so call one before you start a round of edits you might want back.',
      )
    }

    let index: number

    if (iteration !== undefined) {
      index = stack.findIndex((c) => c.iteration === iteration)
      if (index < 0) {
        return fail(
          `No restore point for iteration ${iteration}. Available: ` +
            `${stack.map((c) => c.iteration).join(', ')}.`,
        )
      }
    } else {
      const current = await hashFile(spritePath).catch(() => null)
      const top = stack.length - 1
      index = current !== null && current === stack[top].hash ? top - 1 : top

      if (index < 0) {
        return fail(
          `Nothing to undo: the sprite is unchanged since preview iteration ${stack[top].iteration}, ` +
            'which is the oldest restore point there is.',
        )
      }
    }

    const target = stack[index]

    try {
      await fs.copyFile(target.file, spritePath)
    } catch (err) {
      return fail(`Could not restore the snapshot: ${String(err)}`)
    }

    // Everything after the restored point describes work that has just been thrown away. Dropping it
    // keeps undo monotonic: without this, a later undo could land in a state the model already
    // rejected, having built the current one on top of an earlier checkpoint.
    const discarded = stack.slice(index + 1)
    for (const c of discarded) await fs.rm(c.file, { force: true }).catch(() => {})
    stack.length = index + 1

    return {
      ok: true,
      restoredTo: target.iteration,
      result: {
        ok: true,
        restored_to_iteration: target.iteration,
        discarded_restore_points: discarded.length,
        note:
          `The sprite is now exactly what you saw in preview iteration ${target.iteration}. ` +
          'Everything drawn since is gone, and the preview images of it have been removed from this ' +
          'conversation so they cannot mislead you. Redo the part you wanted, then `render_preview`.',
      },
    }
  }
}

function fail(error: string): RestoreOutcome {
  return { ok: false, result: { error } }
}

async function hashFile(file: string): Promise<string> {
  return crypto.createHash('sha1').update(await fs.readFile(file)).digest('hex')
}
