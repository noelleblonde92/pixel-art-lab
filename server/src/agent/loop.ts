import path from 'node:path'
import { config } from '../config.js'
import type { ModelInfo, RunEndReason, RunEvent, RunRequest } from '../types.js'
import { PixelMcp } from '../mcp/client.js'
import { buildToolset, matchToolName } from '../mcp/toolset.js'
import { PathViolation, sandboxArgs, toWorkspaceRelative } from '../mcp/paths.js'
import { newSprite } from '../mcp/newSprite.js'
import { drawPixels } from '../mcp/drawPixels.js'
import { renderPreview } from '../mcp/preview.js'
import { Checkpoints } from '../mcp/checkpoints.js'
import { buildSystemPrompt } from './prompt.js'
import { buildFirstUserMessage, History } from './history.js'
import {
  FatalOpenRouterError,
  runTurn,
  type ContentPart,
  type ToolCallPayload,
  type TurnResult,
} from '../openrouter/stream.js'

export interface AgentRunOptions {
  runId: string
  runDir: string
  request: RunRequest
  model: ModelInfo
  referenceFiles: string[]
  referenceDataUris: string[]
  signal: AbortSignal
  emit: (event: RunEvent) => void
}

export interface AgentOutcome {
  reason: RunEndReason
  turns: number
  iterations: number
  toolCalls: number
  cost: number
  finalSprite?: string
  finalPng?: string
  message?: string
}

/**
 * What ends the run, other than the model saying it is done.
 *
 * `maxTurns` always has a value; the other two are opt-in, and blank on the form means "no cap of
 * that kind" rather than a default, so that adding a budget is always a deliberate choice and two
 * runs stay comparable when neither asked for one.
 */
export interface RunLimits {
  maxTurns: number
  maxIterations?: number
  maxCostUsd?: number
}

export function resolveLimits(request: RunRequest): RunLimits {
  const clamp = (value: number | undefined, ceiling: number): number | undefined =>
    typeof value === 'number' && value > 0 ? Math.min(value, ceiling) : undefined

  return {
    maxTurns: clamp(request.maxTurns, config.turnCeiling) ?? config.defaultMaxTurns,
    maxIterations: clamp(request.maxIterations, config.iterationCeiling),
    maxCostUsd: clamp(request.maxCostUsd, config.costCeilingUsd),
  }
}

/**
 * The budget as the model sees it, reported on every preview result.
 *
 * The system prompt states the totals once and then goes stale: a model twelve turns in knows it
 * started with twenty and has no way to count what it has spent, because pruning rewrites the
 * history it would have to count. Previews are where that matters — the look-and-fix cycle is what
 * the model paces, so the answer rides along with the image rather than costing a message of its
 * own. Only caps that are real are named, for the same reason `budgetDirective` omits them: a model
 * told about a limit it cannot hit paces itself against a fiction.
 */
export function budgetStatus(
  spent: { turns: number; iterations: number; cost: number },
  limits: RunLimits,
): string {
  const parts = [
    `Turn ${spent.turns} of ${limits.maxTurns} (${Math.max(0, limits.maxTurns - spent.turns)} left).`,
  ]

  if (limits.maxIterations !== undefined) {
    const left = Math.max(0, limits.maxIterations - spent.iterations)
    parts.push(`Preview iteration ${spent.iterations} of ${limits.maxIterations} (${left} left).`)
  }

  if (limits.maxCostUsd !== undefined) {
    parts.push(`Spent $${spent.cost.toFixed(4)} of the $${limits.maxCostUsd.toFixed(4)} limit.`)
  }

  return parts.join(' ')
}

interface PendingPreview {
  parts: ContentPart[]
  description: string
  /** Workspace-relative, matching the `undo` event — what scopes an undo's drop to one sprite. */
  spritePath: string
}

/**
 * The span of preview iterations a successful `undo` invalidated: everything after the one restored
 * to, up to the newest that existed when the call ran. Bounded at the top because a later preview in
 * the same turn is a look at the *restored* canvas and is the one image worth keeping.
 */
interface UndoneRange {
  spritePath: string
  from: number
  through: number
}

interface CallOutcome {
  result: unknown
  preview?: PendingPreview
  undone?: UndoneRange
}

export async function runAgent(opts: AgentRunOptions): Promise<AgentOutcome> {
  const { runDir, request, model, signal, emit } = opts

  const limits = resolveLimits(request)

  const mcp = await PixelMcp.start(runDir)

  /** One snapshot per preview, so `undo` can put the sprite back to a state the model has judged. */
  const checkpoints = new Checkpoints(runDir)

  const state = {
    turns: 0,
    /** Previews the model actually got to look at — a failed render is not a look at the work. */
    iterations: 0,
    toolCalls: 0,
    previewSeq: 0,
    cost: 0,
    contextRatio: 0,
    sawPreview: false,
    /** The nudge below fires at most once, so a stubborn model cannot be looped forever. */
    nudged: false,
    /**
     * Empty responses *in a row*. Any turn that carries something clears it, so a broken endpoint
     * still cannot burn the budget while a run that hiccupped once an hour ago is not punished.
     */
    emptyStreak: 0,
    lastSprite: undefined as string | undefined,
    message: undefined as string | undefined,
  }

  const finish = (reason: RunEndReason): AgentOutcome => ({
    reason,
    turns: state.turns,
    iterations: state.iterations,
    toolCalls: state.toolCalls,
    cost: state.cost,
    finalSprite: state.lastSprite,
    message: state.message,
  })

  try {
    const mcpTools = await mcp.listTools()
    const tools = buildToolset(mcpTools, request.toolset ?? 'core', model.supportsVision)
    const toolNames = new Set(tools.map((t) => t.function.name))

    emit({
      t: 'run.start',
      runId: opts.runId,
      model: model.id,
      maxTurns: limits.maxTurns,
      maxIterations: limits.maxIterations,
      maxCostUsd: limits.maxCostUsd,
      toolCount: tools.length,
    })

    const system = buildSystemPrompt({
      request,
      limits,
      referenceFiles: opts.referenceFiles.map((f) => toWorkspaceRelative(f, runDir)),
      hasVision: model.supportsVision,
    })

    const history = new History(
      system,
      buildFirstUserMessage(request.prompt, opts.referenceDataUris, model.supportsVision),
    )

    // Models that cache automatically need nothing from us; the rest get breakpoints or pay full
    // input price on every one of the run's round-trips.
    const cacheBreakpoints = config.promptCaching && model.needsCacheBreakpoints

    /** Run one tool call: resolve the name, sandbox its paths, dispatch, and report. */
    const executeCall = async (call: ToolCallPayload): Promise<CallOutcome> => {
      const started = Date.now()
      const requested = call.function.name
      const resolvedName = matchToolName(requested, toolNames)

      let args: Record<string, unknown>
      try {
        args = call.function.arguments.trim()
          ? (JSON.parse(call.function.arguments) as Record<string, unknown>)
          : {}
      } catch (err) {
        // Malformed JSON is recoverable — tell the model what broke and let it retry.
        const result = {
          error: `Could not parse the arguments as JSON: ${String(err)}. Re-send this call with valid JSON.`,
        }
        emit({ t: 'tool.call', id: call.id, name: requested, args: call.function.arguments })
        emit({ t: 'tool.result', id: call.id, name: requested, ok: false, result, ms: Date.now() - started })
        return { result }
      }

      emit({ t: 'tool.call', id: call.id, name: resolvedName ?? requested, args })

      if (!resolvedName) {
        const result = {
          error: `No such tool "${requested}". Available tools: ${[...toolNames].join(', ')}`,
        }
        emit({ t: 'tool.result', id: call.id, name: requested, ok: false, result, ms: Date.now() - started })
        return { result }
      }

      let sandboxed: Record<string, unknown>
      try {
        sandboxed = await sandboxArgs(args, runDir)
      } catch (err) {
        // Path rejections become tool errors so the model self-corrects instead of the run dying.
        const result = {
          error: err instanceof PathViolation ? err.message : `Invalid path argument: ${String(err)}`,
        }
        emit({ t: 'tool.result', id: call.id, name: resolvedName, ok: false, result, ms: Date.now() - started })
        return { result }
      }

      try {
        if (resolvedName === 'new_sprite') {
          const res = await newSprite(mcp, sandboxed, runDir)
          const spritePath = (res.result as { sprite_path?: string }).sprite_path
          if (res.ok && spritePath) state.lastSprite = spritePath
          emit({
            t: 'tool.result',
            id: call.id,
            name: resolvedName,
            ok: res.ok,
            result: res.result,
            ms: Date.now() - started,
          })
          return { result: res.result }
        }

        if (resolvedName === 'render_preview') {
          state.previewSeq++
          const res = await renderPreview(mcp, sandboxed, runDir, state.previewSeq)

          // A render the model never got an image back from is not a look at its work: it is not an
          // iteration, and it carries no budget line, because the count it quoted would be wrong.
          const looked = res.ok && res.image !== undefined
          if (looked && res.image) {
            state.sawPreview = true
            state.iterations++
            // The state about to be judged is the one `undo` puts back, which is why the snapshot
            // hangs off the preview rather than off the edits: a checkpoint nobody looked at is not
            // a state the model can ask to return to.
            await checkpoints.capture(res.image.spritePath, state.iterations).catch((err: unknown) => {
              emit({ t: 'warning', message: `Could not snapshot the sprite for undo: ${String(err)}` })
            })
          }

          // Tallied before the line is built so it counts this preview, and emitted after so the
          // transcript records the result the model actually read.
          const result = looked
            ? { ...(res.result as Record<string, unknown>), budget: budgetStatus(state, limits) }
            : res.result

          emit({
            t: 'tool.result',
            id: call.id,
            name: resolvedName,
            ok: res.ok,
            result,
            ms: Date.now() - started,
          })

          if (!res.ok || !res.image) return { result }

          const rel = toWorkspaceRelative(res.image.spritePath, runDir)
          state.lastSprite = rel
          const dims = `${res.image.sourceWidth}x${res.image.sourceHeight} shown at ${res.image.scale}x`

          emit({
            t: 'preview',
            id: call.id,
            url: `/api/runs/${opts.runId}/files/exports/${res.image.fileName}`,
            spritePath: rel,
            width: res.image.sourceWidth,
            height: res.image.sourceHeight,
            scale: res.image.scale,
            note: res.image.note,
          })

          // The message names its iteration because that number is what `undo` takes — without it,
          // an uncapped run never states the number anywhere (the budget line only counts
          // iterations when an iteration cap exists).
          return {
            result,
            preview: {
              parts: [
                {
                  type: 'text',
                  text: `Preview of ${rel}, iteration ${state.iterations} (${dims}). Judge it and fix what is wrong.`,
                },
                { type: 'image_url', image_url: { url: res.image.dataUri } },
              ],
              description: `preview of ${rel} from iteration ${state.iterations} of turn ${state.turns} (${dims})`,
              spritePath: rel,
            },
          }
        }

        // Undo restores a file rather than replaying anything: pixel-mcp is stateless, so the
        // snapshot taken at a preview is a complete state and copying it back is the whole revert.
        if (resolvedName === 'undo') {
          const spritePath = typeof sandboxed.sprite_path === 'string' ? sandboxed.sprite_path : ''
          // `iteration: null` must mean "not given", the same as omitting it — Number(null) is 0,
          // which would otherwise turn a default undo into a lookup for iteration 0.
          const raw = sandboxed.iteration
          const asked =
            typeof raw === 'number' || (typeof raw === 'string' && raw.trim() !== '')
              ? Math.trunc(Number(raw))
              : NaN
          const iteration = Number.isFinite(asked) ? asked : undefined

          const res: { ok: boolean; result: unknown; restoredTo?: number } = spritePath
            ? await checkpoints.restore(spritePath, iteration)
            : { ok: false, result: { error: 'sprite_path is required' } }

          const rel = spritePath ? toWorkspaceRelative(spritePath, runDir) : ''
          if (res.ok) state.lastSprite = rel

          emit({
            t: 'tool.result',
            id: call.id,
            name: resolvedName,
            ok: res.ok,
            result: res.result,
            ms: Date.now() - started,
          })

          if (res.restoredTo !== undefined) {
            emit({ t: 'undo', id: call.id, spritePath: rel, restoredTo: res.restoredTo })
          }

          // `state.iterations` is the newest preview that exists or is pending for this turn, so it
          // closes the range: anything the model previews after this call is a look at the restored
          // canvas and stays.
          return {
            result: res.result,
            undone:
              res.restoredTo !== undefined
                ? { spritePath: rel, from: res.restoredTo, through: state.iterations }
                : undefined,
          }
        }

        // draw_pixels is wrapped rather than forwarded: it addresses the cel rather than the canvas
        // and drops whatever falls outside it while still reporting success. See mcp/drawPixels.ts.
        const res = await (resolvedName === 'draw_pixels'
          ? drawPixels(mcp, sandboxed)
          : mcp.callTool(resolvedName, sandboxed).then((r) => ({
              ok: r.ok,
              result: r.ok ? safeParse(r.text) : { error: r.text },
            })))
        const result = res.result

        if (res.ok && typeof sandboxed.sprite_path === 'string') {
          state.lastSprite = toWorkspaceRelative(sandboxed.sprite_path, runDir)
        }

        emit({
          t: 'tool.result',
          id: call.id,
          name: resolvedName,
          ok: res.ok,
          result,
          ms: Date.now() - started,
        })
        return { result }
      } catch (err) {
        const result = { error: `Tool call failed: ${String(err)}` }
        emit({ t: 'tool.result', id: call.id, name: resolvedName, ok: false, result, ms: Date.now() - started })
        return { result }
      }
    }

    // Why the loop ended, once it has. Turns are the only limit that can expire before a turn runs,
    // so they are the standing answer; the budgets below overwrite it when one of them lands first.
    let exhausted: RunEndReason = 'max_turns'

    while (state.turns < limits.maxTurns) {
      if (signal.aborted) return finish('cancelled')

      // The turn number is claimed only once a response actually arrives. A dropped response is
      // retried in place, under this same number: the provider failing to answer is not the model
      // spending a turn, and charging the retries to the turn budget would quietly shorten the run
      // the form asked for.
      const n = state.turns + 1
      emit({ t: 'turn.start', n })

      let turn: TurnResult
      for (;;) {
        turn = await runTurn(
          {
            model: model.id,
            messages: history.toArray(cacheBreakpoints),
            tools,
            effort: request.reasoningEffort,
            sendReasoning: model.supportsReasoning,
            cacheBreakpoints,
            signal,
          },
          {
            onText: (text) => emit({ t: 'text.delta', text }),
            onReasoning: (text) => emit({ t: 'reasoning.delta', text }),
          },
        )

        // Every attempt is billed, so every attempt is accounted for — only the turn tally is spared.
        state.cost += turn.usage.cost
        emit({
          t: 'usage',
          promptTokens: turn.usage.promptTokens,
          completionTokens: turn.usage.completionTokens,
          reasoningTokens: turn.usage.reasoningTokens,
          cachedTokens: turn.usage.cachedTokens,
          cacheWriteTokens: turn.usage.cacheWriteTokens,
          cost: turn.usage.cost,
          cumulativeCost: state.cost,
        })
        if (model.contextLength > 0) {
          state.contextRatio = turn.usage.promptTokens / model.contextLength
        }

        // A response with nothing in it at all is a provider failure wearing the costume of a
        // finished run: no tool calls is also how a model signals "done", so left alone it scores as
        // a clean finish. Run e32b48be ended this way on a blank canvas. These are usually transient,
        // so retry — and only call the endpoint dead once `emptyResponseLimit` land back to back,
        // rather than claiming 'done'. The streak is what matters: two blanks twenty turns apart are
        // two recovered hiccups, not a model that stopped answering.
        if (!isEmptyResponse(turn)) break

        state.emptyStreak++
        if (state.emptyStreak >= config.emptyResponseLimit) {
          state.message = `The model returned an empty response ${state.emptyStreak} times in a row.`
          return finish('empty_response')
        }
        const delays = config.emptyResponseDelaysMs
        const wait = delays[Math.min(state.emptyStreak, delays.length) - 1]
        emit({
          t: 'warning',
          message:
            `Model returned an empty response (${state.emptyStreak} in a row); ` +
            `retrying the turn in ${wait / 1000}s.`,
        })
        await sleep(wait, signal)
        if (signal.aborted) return finish('cancelled')
      }

      state.turns = n
      state.emptyStreak = 0

      // No tool calls means the model considers itself finished.
      if (turn.toolCalls.length === 0) {
        if (!state.sawPreview && !state.nudged && model.supportsVision) {
          state.nudged = true
          history.push({ role: 'assistant', content: turn.text || '' })
          history.push({
            role: 'user',
            content:
              'You have not looked at your work yet. Call render_preview on your sprite, judge what ' +
              'you see honestly — silhouette, value separation, stray pixels — then fix anything ' +
              'wrong before finishing.',
          })
          emit({ t: 'warning', message: 'Model tried to finish without previewing; nudged once.' })
          continue
        }
        state.message = turn.text.trim() || undefined
        return finish('done')
      }

      history.push({ role: 'assistant', content: turn.text || null, tool_calls: turn.toolCalls })

      // Strictly sequential: pixel-mcp gives no concurrency guarantees on a single file, and a model
      // can happily emit two calls that mutate the same sprite in one turn.
      const pendingPreviews: PendingPreview[] = []
      /** Kept as separate spans, not merged: a preview between two undos survives both. */
      const undone: UndoneRange[] = []

      for (const call of turn.toolCalls) {
        if (signal.aborted) return finish('cancelled')

        if (state.toolCalls >= config.toolCallCeiling) {
          state.message = `Stopped after ${config.toolCallCeiling} tool calls.`
          return finish('max_tool_calls')
        }
        state.toolCalls++

        const outcome = await executeCall(call)
        history.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(outcome.result).slice(0, 8000),
        })
        if (outcome.preview) pendingPreviews.push(outcome.preview)
        if (outcome.undone) undone.push(outcome.undone)
      }

      // Images go in user messages after all tool results: a tool message must immediately follow the
      // assistant's tool_calls, and image-in-tool-result support varies too much across providers.
      for (const preview of pendingPreviews) {
        history.pushPreview(preview.parts, preview.description, preview.spritePath)
      }

      // Applied after the previews land, not inside the undo call: a turn that previews and *then*
      // undoes has the image it just discarded still sitting in `pendingPreviews`, and dropping it
      // earlier would miss the one picture most likely to mislead the next turn.
      for (const range of undone) {
        history.dropUndonePreviews(range.spritePath, range.from, range.through)
      }

      const notice = history.prune(state.contextRatio)
      if (notice) emit({ t: 'warning', message: notice })

      // Budgets are checked between turns rather than mid-turn: the turn's edits all land, and the
      // spend that pushed the run over its limit is the last spend it makes.
      if (limits.maxIterations !== undefined && state.iterations >= limits.maxIterations) {
        exhausted = 'max_iterations'
        break
      }
      if (limits.maxCostUsd !== undefined && state.cost >= limits.maxCostUsd) {
        exhausted = 'max_cost'
        break
      }
    }

    // A cost limit is the one budget a sign-off turn would itself violate, so that run just stops.
    if (exhausted === 'max_cost') {
      state.message =
        `Stopped after spending $${state.cost.toFixed(4)} of the $${limits.maxCostUsd?.toFixed(4)} ` +
        `cost limit, in ${state.turns} turns and ${state.iterations} iterations.`
      return finish('max_cost')
    }

    // Out of budget — let it sign off without editing further.
    history.push({
      role: 'user',
      content:
        `You have reached the ${exhausted === 'max_iterations' ? 'preview iteration' : 'turn'} ` +
        'limit. Make no further edits. Reply with a one-paragraph summary of what you made and ' +
        'what you would fix with more time.',
    })
    const last = await runTurn(
      {
        model: model.id,
        messages: history.toArray(cacheBreakpoints),
        tools: [],
        effort: request.reasoningEffort,
        sendReasoning: model.supportsReasoning,
        cacheBreakpoints,
        signal,
      },
      {
        onText: (text) => emit({ t: 'text.delta', text }),
        onReasoning: (text) => emit({ t: 'reasoning.delta', text }),
      },
    ).catch(() => null)

    state.cost += last?.usage.cost ?? 0
    state.message =
      last?.text.trim() ||
      (exhausted === 'max_iterations'
        ? `Reached the limit of ${limits.maxIterations} preview iterations.`
        : `Reached the limit of ${limits.maxTurns} turns.`)
    return finish(exhausted)
  } catch (err) {
    if (err instanceof FatalOpenRouterError) {
      state.message = err.message
      return finish('error')
    }
    if (signal.aborted) return finish('cancelled')
    state.message = String(err)
    return finish('error')
  } finally {
    await mcp.close()
  }
}

/**
 * A turn that carries nothing at all: no tool calls, no prose, not even reasoning.
 *
 * The prompt asks for a plain-text summary as the finish signal, so silence is never a valid way to
 * say "done" — it means the provider dropped the response. Worth separating, because cost is a
 * benchmark axis and a dropped turn that scores as a clean finish quietly corrupts the comparison.
 */
export function isEmptyResponse(turn: Pick<TurnResult, 'text' | 'reasoning' | 'toolCalls'>): boolean {
  return turn.toolCalls.length === 0 && !turn.text.trim() && !turn.reasoning.trim()
}

/**
 * Wait, but wake immediately if the run is cancelled.
 *
 * Resolves on abort rather than rejecting, because cancellation here is not an error: the caller
 * `continue`s straight into the loop's own `signal.aborted` check, which ends the run as
 * `cancelled`. Rejecting would route the same thing through the catch as a failure instead.
 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return { output: text }
  }
}

/** Best-effort final export so the UI always has something to show and download. */
export async function exportFinal(
  runDir: string,
  spriteRelPath: string | undefined,
): Promise<string | undefined> {
  if (!spriteRelPath) return undefined
  const mcp = await PixelMcp.start(runDir)
  try {
    const res = await mcp.callTool('export_sprite', {
      sprite_path: path.resolve(runDir, spriteRelPath),
      output_path: path.join(runDir, 'exports', 'final.png'),
      format: 'png',
      frame_number: 0,
    })
    return res.ok ? 'exports/final.png' : undefined
  } catch {
    return undefined
  } finally {
    await mcp.close()
  }
}
