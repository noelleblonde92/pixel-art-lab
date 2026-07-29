import { describe, expect, it } from 'vitest'
import { migrateEntry, summarizeEvents } from './gallery.js'
import type { GalleryEntry, RunEvent } from './types.js'

const usage = (over: Partial<Extract<RunEvent, { t: 'usage' }>> = {}): RunEvent => ({
  t: 'usage',
  promptTokens: 1000,
  completionTokens: 100,
  reasoningTokens: 40,
  cachedTokens: 900,
  cacheWriteTokens: 0,
  cost: 0.001,
  cumulativeCost: 0.001,
  ...over,
})

describe('summarizeEvents', () => {
  it('accumulates tokens and takes the last cumulative cost', () => {
    const stats = summarizeEvents(
      [usage(), usage({ cumulativeCost: 0.004 }), usage({ cumulativeCost: 0.009 })],
      12_000,
    )

    expect(stats.promptTokens).toBe(3000)
    expect(stats.completionTokens).toBe(300)
    expect(stats.reasoningTokens).toBe(120)
    expect(stats.cachedTokens).toBe(2700)
    expect(stats.cost).toBe(0.009)
    expect(stats.durationMs).toBe(12_000)
  })

  it('counts turns, tool calls and preview iterations separately', () => {
    const stats = summarizeEvents(
      [
        { t: 'turn.start', n: 1 },
        { t: 'tool.call', id: 'a', name: 'draw_line', args: {} },
        { t: 'tool.call', id: 'b', name: 'render_preview', args: {} },
        { t: 'preview', id: 'b', url: '/x.png', spritePath: 's.aseprite', width: 32, height: 32, scale: 8 },
        { t: 'turn.start', n: 2 },
        { t: 'tool.call', id: 'c', name: 'draw_line', args: {} },
      ],
      0,
    )

    expect(stats.turns).toBe(2)
    expect(stats.toolCalls).toBe(3)
    expect(stats.iterations).toBe(1)
  })

  // run.end carries the run's own authoritative tallies; a mid-run save has to fall back to
  // whatever the stream has shown so far.
  it('prefers the run.end tallies once the run has finished', () => {
    const stats = summarizeEvents(
      [
        { t: 'turn.start', n: 1 },
        usage({ cumulativeCost: 0.002 }),
        { t: 'run.end', reason: 'done', turns: 7, iterations: 4, toolCalls: 31, cost: 0.0125 },
      ],
      5_000,
    )

    expect(stats.turns).toBe(7)
    expect(stats.iterations).toBe(4)
    expect(stats.toolCalls).toBe(31)
    expect(stats.cost).toBe(0.0125)
    expect(stats.endReason).toBe('done')
  })

  it('keeps the streamed totals when a run ends without them', () => {
    const stats = summarizeEvents(
      [
        { t: 'turn.start', n: 3 },
        { t: 'tool.call', id: 'a', name: 'draw_line', args: {} },
        usage({ cumulativeCost: 0.05 }),
        { t: 'run.end', reason: 'error', turns: 0, iterations: 0, toolCalls: 0, cost: 0, message: 'boom' },
      ],
      900,
    )

    expect(stats.turns).toBe(3)
    expect(stats.toolCalls).toBe(1)
    expect(stats.cost).toBe(0.05)
    expect(stats.endReason).toBe('error')
  })

  // events.jsonl outlives the code that wrote it: a pre-split run calls every round-trip an
  // iteration, and its run.end tally counts round-trips.
  it('reads a run recorded before turns and iterations were separate', () => {
    const legacy = [
      { t: 'iteration.start', n: 1 },
      { t: 'preview', id: 'b', url: '/x.png', spritePath: 's.aseprite', width: 32, height: 32, scale: 8 },
      { t: 'iteration.start', n: 2 },
      { t: 'run.end', reason: 'done', iterations: 9, toolCalls: 20, cost: 0.02 },
    ] as unknown as RunEvent[]

    const stats = summarizeEvents(legacy, 1_000)

    expect(stats.turns).toBe(9)
    expect(stats.iterations).toBe(1) // from the preview events, not from run.end
    expect(stats.toolCalls).toBe(20)
  })
})

describe('migrateEntry', () => {
  const legacy = {
    id: 'a'.repeat(12),
    savedAt: 1,
    runId: 'run1',
    request: { prompt: 'A knight', model: 'anthropic/claude', maxIterations: 30 },
    sourceFile: 'exports/final.png',
    width: 32,
    height: 32,
    scale: 1,
    hasSprite: true,
    stats: {
      iterations: 12,
      previews: 5,
      toolCalls: 40,
      cost: 0.01,
      promptTokens: 100,
      completionTokens: 10,
      reasoningTokens: 0,
      cachedTokens: 0,
      durationMs: 1000,
    },
  } as unknown as GalleryEntry

  it('rereads a pre-split entry in the current vocabulary', () => {
    const entry = migrateEntry(legacy)

    expect(entry.stats.turns).toBe(12)
    expect(entry.stats.iterations).toBe(5)
    expect(entry.request.maxTurns).toBe(30)
    expect(entry.request.maxIterations).toBeUndefined()
  })

  it('leaves a current entry alone', () => {
    const current = {
      ...legacy,
      request: { ...legacy.request, maxTurns: 40, maxIterations: 8 },
      stats: { ...legacy.stats, turns: 12, iterations: 5 },
    }

    expect(migrateEntry(current)).toEqual(current)
  })
})
