import type { RunEndReason, RunEvent } from '../types'

/**
 * The transcript, derived from the raw event stream.
 *
 * Deltas arrive token by token, and tool results arrive separately from their calls. Folding them
 * into stable entries here keeps rendering dumb and makes the merging logic testable.
 */
export type Entry =
  | { kind: 'turn'; key: string; n: number }
  | { kind: 'text'; key: string; text: string }
  | { kind: 'reasoning'; key: string; text: string }
  | {
      kind: 'tool'
      key: string
      id: string
      name: string
      args: unknown
      ok?: boolean
      result?: unknown
      ms?: number
    }
  | {
      kind: 'preview'
      key: string
      id: string
      url: string
      spritePath: string
      width: number
      height: number
      scale: number
      note?: string
      index: number
    }
  | { kind: 'warning'; key: string; message: string }

export interface Preview {
  id: string
  url: string
  spritePath: string
  width: number
  height: number
  scale: number
  note?: string
  index: number
  /** Which model round-trip produced it. The preview's own iteration number is `index + 1`. */
  turn: number
}

export interface Timeline {
  entries: Entry[]
  /** One preview is one iteration, so `previews.length` is the iteration tally. */
  previews: Preview[]
  turn: number
  maxTurns: number
  /** Only set when the run asked for that cap. */
  maxIterations?: number
  maxCostUsd?: number
  toolCalls: number
  promptTokens: number
  completionTokens: number
  reasoningTokens: number
  /** Counted within promptTokens — a share, not an addition. */
  cachedTokens: number
  cost: number
  model?: string
  toolCount: number
  status: 'idle' | 'running' | 'finished'
  endReason?: RunEndReason
  endMessage?: string
  finalSprite?: string
  finalPng?: string
}

export function buildTimeline(events: RunEvent[]): Timeline {
  const timeline: Timeline = {
    entries: [],
    previews: [],
    turn: 0,
    maxTurns: 0,
    toolCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
    cost: 0,
    toolCount: 0,
    status: events.length ? 'running' : 'idle',
  }

  const toolIndex = new Map<string, number>()
  let seq = 0

  for (const event of events) {
    switch (event.t) {
      case 'run.start':
        timeline.model = event.model
        timeline.maxTurns = event.maxTurns
        timeline.maxIterations = event.maxIterations
        timeline.maxCostUsd = event.maxCostUsd
        timeline.toolCount = event.toolCount
        break

      case 'turn.start':
        timeline.turn = event.n
        timeline.entries.push({ kind: 'turn', key: `turn-${event.n}`, n: event.n })
        break

      case 'text.delta':
      case 'reasoning.delta': {
        const kind = event.t === 'text.delta' ? 'text' : 'reasoning'
        const last = timeline.entries[timeline.entries.length - 1]
        // Merge consecutive deltas of the same kind into one block.
        if (last && last.kind === kind) {
          last.text += event.text
        } else {
          timeline.entries.push({ kind, key: `${kind}-${seq++}`, text: event.text })
        }
        break
      }

      case 'tool.call':
        timeline.toolCalls++
        toolIndex.set(event.id, timeline.entries.length)
        timeline.entries.push({
          kind: 'tool',
          key: `tool-${event.id}-${seq++}`,
          id: event.id,
          name: event.name,
          args: event.args,
        })
        break

      case 'tool.result': {
        const at = toolIndex.get(event.id)
        const entry = at === undefined ? undefined : timeline.entries[at]
        if (entry && entry.kind === 'tool') {
          entry.ok = event.ok
          entry.result = event.result
          entry.ms = event.ms
        }
        break
      }

      case 'preview': {
        const index = timeline.previews.length
        const preview: Preview = {
          id: event.id,
          url: event.url,
          spritePath: event.spritePath,
          width: event.width,
          height: event.height,
          scale: event.scale,
          note: event.note,
          index,
          turn: timeline.turn,
        }
        timeline.previews.push(preview)
        timeline.entries.push({ kind: 'preview', key: `prev-${index}`, ...preview })
        break
      }

      case 'usage':
        timeline.promptTokens += event.promptTokens
        timeline.completionTokens += event.completionTokens
        timeline.reasoningTokens += event.reasoningTokens
        timeline.cachedTokens += event.cachedTokens
        timeline.cost = event.cumulativeCost
        break

      case 'warning':
        timeline.entries.push({ kind: 'warning', key: `warn-${seq++}`, message: event.message })
        break

      case 'run.end':
        timeline.status = 'finished'
        timeline.endReason = event.reason
        timeline.endMessage = event.message
        timeline.finalSprite = event.finalSprite
        timeline.finalPng = event.finalPng
        timeline.cost = event.cost || timeline.cost
        timeline.toolCalls = event.toolCalls || timeline.toolCalls
        break
    }
  }

  return timeline
}

export function endReasonLabel(reason: RunEndReason): string {
  switch (reason) {
    case 'done':
      return 'Finished'
    case 'max_turns':
      return 'Hit the turn limit'
    case 'max_iterations':
      return 'Hit the iteration limit'
    case 'max_cost':
      return 'Hit the cost limit'
    case 'max_tool_calls':
      return 'Hit the tool call limit'
    case 'empty_response':
      return 'Model returned nothing'
    case 'cancelled':
      return 'Stopped'
    case 'error':
      return 'Failed'
  }
}
