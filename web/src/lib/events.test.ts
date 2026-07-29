import { describe, expect, it } from 'vitest'
import { buildTimeline } from './events'
import type { RunEvent } from '../types'

const start: RunEvent = {
  t: 'run.start',
  runId: 'abc',
  model: 'anthropic/claude-opus-5',
  maxTurns: 40,
  maxIterations: 6,
  maxCostUsd: 0.5,
  toolCount: 28,
}

describe('buildTimeline', () => {
  it('is idle before anything happens', () => {
    expect(buildTimeline([]).status).toBe('idle')
  })

  it('merges consecutive text deltas into one block', () => {
    const timeline = buildTimeline([
      start,
      { t: 'text.delta', text: 'Blocking ' },
      { t: 'text.delta', text: 'in the ' },
      { t: 'text.delta', text: 'silhouette.' },
    ])
    const texts = timeline.entries.filter((e) => e.kind === 'text')
    expect(texts).toHaveLength(1)
    expect(texts[0]).toMatchObject({ text: 'Blocking in the silhouette.' })
  })

  it('keeps reasoning and text in separate blocks', () => {
    const timeline = buildTimeline([
      { t: 'reasoning.delta', text: 'thinking' },
      { t: 'text.delta', text: 'saying' },
      { t: 'reasoning.delta', text: 'more' },
    ])
    expect(timeline.entries.map((e) => e.kind)).toEqual(['reasoning', 'text', 'reasoning'])
  })

  it('attaches a tool result to its matching call', () => {
    const timeline = buildTimeline([
      start,
      { t: 'tool.call', id: 'c1', name: 'draw_line', args: { x1: 0 } },
      { t: 'tool.result', id: 'c1', name: 'draw_line', ok: true, result: { success: true }, ms: 42 },
    ])
    const call = timeline.entries.find((e) => e.kind === 'tool')
    expect(call).toMatchObject({ name: 'draw_line', ok: true, ms: 42 })
    expect(timeline.toolCalls).toBe(1)
  })

  it('matches results to the right call when several are open at once', () => {
    const timeline = buildTimeline([
      { t: 'tool.call', id: 'a', name: 'first', args: {} },
      { t: 'tool.call', id: 'b', name: 'second', args: {} },
      { t: 'tool.result', id: 'b', name: 'second', ok: false, result: { error: 'nope' }, ms: 5 },
      { t: 'tool.result', id: 'a', name: 'first', ok: true, result: {}, ms: 9 },
    ])
    const tools = timeline.entries.filter((e) => e.kind === 'tool')
    expect(tools[0]).toMatchObject({ name: 'first', ok: true, ms: 9 })
    expect(tools[1]).toMatchObject({ name: 'second', ok: false, ms: 5 })
  })

  it('leaves a call pending until its result arrives', () => {
    const timeline = buildTimeline([{ t: 'tool.call', id: 'x', name: 'slow', args: {} }])
    const call = timeline.entries.find((e) => e.kind === 'tool')
    expect(call).toBeDefined()
    expect(call?.kind).toBe('tool')
    if (call?.kind !== 'tool') throw new Error('expected a tool entry')
    expect(call.ok).toBeUndefined()
    expect(call.ms).toBeUndefined()
  })

  it('carries the run budgets off run.start', () => {
    const timeline = buildTimeline([start])
    expect(timeline).toMatchObject({ maxTurns: 40, maxIterations: 6, maxCostUsd: 0.5 })
  })

  // One preview is one iteration, so the previews list doubles as the iteration tally.
  it('indexes previews and tags each with the turn it came from', () => {
    const timeline = buildTimeline([
      start,
      { t: 'turn.start', n: 1 },
      preview('p1'),
      { t: 'turn.start', n: 2 },
      preview('p2'),
    ])
    expect(timeline.previews).toHaveLength(2)
    expect(timeline.previews[0]).toMatchObject({ index: 0, turn: 1 })
    expect(timeline.previews[1]).toMatchObject({ index: 1, turn: 2 })
  })

  it('marks the previews an undo threw away, and only those', () => {
    const timeline = buildTimeline([
      start,
      { t: 'turn.start', n: 1 },
      preview('p1'),
      { t: 'turn.start', n: 2 },
      preview('p2'),
      { t: 'turn.start', n: 3 },
      preview('p3'),
      { t: 'undo', id: 'u1', spritePath: 'sprites/knight.aseprite', restoredTo: 1 },
    ])
    expect(timeline.previews.map((p) => p.undone ?? false)).toEqual([false, true, true])
  })

  // A preview drawn on top of the restored state is the run moving forward again, not part of the
  // branch that was discarded — so folding in order is what keeps the marking correct.
  it('leaves previews taken after the undo unmarked', () => {
    const timeline = buildTimeline([
      start,
      { t: 'turn.start', n: 1 },
      preview('p1'),
      { t: 'turn.start', n: 2 },
      preview('p2'),
      { t: 'undo', id: 'u1', spritePath: 'sprites/knight.aseprite', restoredTo: 1 },
      { t: 'turn.start', n: 3 },
      preview('p3'),
    ])
    expect(timeline.previews.map((p) => p.undone ?? false)).toEqual([false, true, false])
  })

  // Iterations are numbered globally, but an undo rewinds one sprite — another sprite's frame
  // inside the range is still a true picture of its own canvas.
  it('only marks frames of the sprite that was undone', () => {
    const timeline = buildTimeline([
      start,
      { t: 'turn.start', n: 1 },
      preview('p1'),
      { t: 'turn.start', n: 2 },
      preview('p2', 'sprites/tree.aseprite'),
      { t: 'turn.start', n: 3 },
      preview('p3'),
      { t: 'undo', id: 'u1', spritePath: 'sprites/knight.aseprite', restoredTo: 1 },
    ])
    expect(timeline.previews.map((p) => p.undone ?? false)).toEqual([false, false, true])
  })

  it('marks the transcript entry as well as the filmstrip frame', () => {
    const timeline = buildTimeline([
      start,
      { t: 'turn.start', n: 1 },
      preview('p1'),
      { t: 'turn.start', n: 2 },
      preview('p2'),
      { t: 'undo', id: 'u1', spritePath: 'sprites/knight.aseprite', restoredTo: 1 },
    ])
    const entries = timeline.entries.filter((e) => e.kind === 'preview')
    expect(entries.map((e) => (e.kind === 'preview' ? (e.undone ?? false) : null))).toEqual([
      false,
      true,
    ])
  })

  it('sums token usage but takes cost as the running cumulative', () => {
    const timeline = buildTimeline([
      usage(100, 20, 0.001, 0.001),
      usage(300, 40, 0.002, 0.003),
    ])
    expect(timeline.promptTokens).toBe(400)
    expect(timeline.completionTokens).toBe(60)
    expect(timeline.cost).toBeCloseTo(0.003)
  })

  it('sums cached tokens as a share of the prompt total, never on top of it', () => {
    const timeline = buildTimeline([
      usage(100, 20, 0.001, 0.001, 0),
      usage(300, 40, 0.002, 0.003, 250),
    ])
    expect(timeline.promptTokens).toBe(400)
    expect(timeline.cachedTokens).toBe(250)
  })

  it('captures the outcome and artifacts on run.end', () => {
    const timeline = buildTimeline([
      start,
      { t: 'turn.start', n: 1 },
      {
        t: 'run.end',
        reason: 'done',
        turns: 12,
        iterations: 5,
        toolCalls: 47,
        cost: 0.42,
        finalSprite: 'sprites/knight.aseprite',
        finalPng: 'exports/final.png',
        message: 'Done.',
      },
    ])
    expect(timeline.status).toBe('finished')
    expect(timeline).toMatchObject({
      endReason: 'done',
      toolCalls: 47,
      cost: 0.42,
      finalSprite: 'sprites/knight.aseprite',
      finalPng: 'exports/final.png',
    })
  })
})

function preview(id: string, spritePath = 'sprites/knight.aseprite'): RunEvent {
  return {
    t: 'preview',
    id,
    url: `/api/runs/abc/files/exports/${id}.png`,
    spritePath,
    width: 32,
    height: 32,
    scale: 8,
  }
}

function usage(
  prompt: number,
  completion: number,
  cost: number,
  cumulative: number,
  cached = 0,
): RunEvent {
  return {
    t: 'usage',
    promptTokens: prompt,
    completionTokens: completion,
    reasoningTokens: 0,
    cachedTokens: cached,
    cacheWriteTokens: 0,
    cost,
    cumulativeCost: cumulative,
  }
}
