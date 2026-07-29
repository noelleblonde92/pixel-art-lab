import { describe, expect, it } from 'vitest'
import { groupByPrompt, leaders, runFileFromUrl } from './gallery'
import type { GalleryEntry } from '../types'

let counter = 0

const entry = (
  prompt: string,
  model: string,
  over: Partial<GalleryEntry> & { cost?: number } = {},
): GalleryEntry => {
  const { cost = 0.01, ...rest } = over
  counter++
  return {
    id: `id${counter}`,
    savedAt: counter,
    runId: `run${counter}`,
    request: { prompt, model },
    sourceFile: 'exports/final.png',
    width: 32,
    height: 32,
    scale: 1,
    hasSprite: true,
    stats: {
      turns: 5,
      iterations: 3,
      toolCalls: 20,
      cost,
      promptTokens: 1000,
      completionTokens: 100,
      reasoningTokens: 0,
      cachedTokens: 0,
      durationMs: 1000,
    },
    ...rest,
  }
}

describe('groupByPrompt', () => {
  it('groups two models answering the same prompt', () => {
    const prompts = groupByPrompt([
      entry('A knight', 'anthropic/claude'),
      entry('A knight', 'openai/gpt'),
      entry('A dragon', 'openai/gpt'),
    ])

    expect(prompts).toHaveLength(2)
    const knight = prompts.find((p) => p.prompt === 'A knight')!
    expect(knight.entries).toHaveLength(2)
    expect(knight.models).toBe(2)
  })

  // Whitespace and case are not a different benchmark question.
  it('ignores case and whitespace differences in the prompt', () => {
    const prompts = groupByPrompt([
      entry('A knight  in armour', 'a/one'),
      entry('a knight in armour\n', 'b/two'),
    ])

    expect(prompts).toHaveLength(1)
    expect(prompts[0].entries).toHaveLength(2)
  })

  it('counts one model twice as one model, two attempts', () => {
    const prompts = groupByPrompt([entry('A knight', 'a/one'), entry('A knight', 'a/one')])

    expect(prompts[0].entries).toHaveLength(2)
    expect(prompts[0].models).toBe(1)
  })

  it('orders groups by their newest save and entries oldest first', () => {
    const old = entry('Old prompt', 'a/one', { savedAt: 10 })
    const first = entry('New prompt', 'a/one', { savedAt: 20 })
    const second = entry('New prompt', 'b/two', { savedAt: 30 })

    const prompts = groupByPrompt([old, second, first])

    expect(prompts.map((p) => p.prompt)).toEqual(['New prompt', 'Old prompt'])
    expect(prompts[0].entries.map((e) => e.savedAt)).toEqual([20, 30])
  })
})

describe('leaders', () => {
  const metric = (e: GalleryEntry) => e.stats.cost

  it('marks the cheapest entry', () => {
    const cheap = entry('A knight', 'a/one', { cost: 0.001 })
    const dear = entry('A knight', 'b/two', { cost: 0.02 })

    expect([...leaders([cheap, dear], metric)]).toEqual([cheap.id])
  })

  it('keeps ties rather than picking one arbitrarily', () => {
    const one = entry('A knight', 'a/one', { cost: 0.004 })
    const two = entry('A knight', 'b/two', { cost: 0.004 })
    const three = entry('A knight', 'c/three', { cost: 0.9 })

    expect(leaders([one, two, three], metric)).toEqual(new Set([one.id, two.id]))
  })

  it('marks nothing when there is nothing to compare against', () => {
    expect(leaders([entry('A knight', 'a/one')], metric).size).toBe(0)
  })
})

describe('runFileFromUrl', () => {
  it('recovers the workspace-relative path a save needs', () => {
    expect(runFileFromUrl('/api/runs/abc123/files/exports/preview-3.png')).toBe(
      'exports/preview-3.png',
    )
  })

  it('returns nothing for a url that is not a run file', () => {
    expect(runFileFromUrl('/api/gallery/abc/image')).toBeUndefined()
  })
})
