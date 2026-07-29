import { describe, expect, it } from 'vitest'
import { History, buildFirstUserMessage } from './history.js'
import type { ContentPart } from '../openrouter/stream.js'

const parts = (label: string): ContentPart[] => [
  { type: 'text', text: label },
  { type: 'image_url', image_url: { url: `data:image/png;base64,${label}` } },
]

function historyWithPreviews(count: number): History {
  const history = new History('system', buildFirstUserMessage('brief', ['data:image/png;base64,REF'], true))
  for (let i = 1; i <= count; i++) {
    history.push({ role: 'assistant', content: `turn ${i}` })
    history.pushPreview(parts(`p${i}`), `[preview ${i} dropped]`)
  }
  return history
}

const imageCount = (history: History): number =>
  history
    .toArray()
    .filter((m) => Array.isArray(m.content))
    .flatMap((m) => m.content as ContentPart[])
    .filter((p) => p.type === 'image_url').length

describe('History.prune', () => {
  it('keeps everything while under the retention limit', () => {
    const history = historyWithPreviews(3)
    expect(history.prune(0)).toBeNull()
    // 3 previews + the reference image attached to the first user message
    expect(imageCount(history)).toBe(4)
  })

  it('collapses older previews to text once past the limit', () => {
    const history = historyWithPreviews(6)
    const notice = history.prune(0)

    expect(notice).toContain('Dropped 3 older preview images')
    // 3 most recent previews survive, plus the untouched reference image
    expect(imageCount(history)).toBe(4)

    const texts = history.toArray().filter((m) => typeof m.content === 'string').map((m) => m.content)
    expect(texts).toContain('[preview 1 dropped]')
    expect(texts).toContain('[preview 3 dropped]')
    expect(texts).not.toContain('[preview 4 dropped]')
  })

  it('never prunes the user reference image', () => {
    const history = historyWithPreviews(8)
    history.prune(0.95)
    const first = history.toArray()[1]
    expect(Array.isArray(first.content)).toBe(true)
    expect((first.content as ContentPart[]).some((p) => p.type === 'image_url')).toBe(true)
  })

  it('keeps fewer previews as context pressure rises', () => {
    const moderate = historyWithPreviews(6)
    moderate.prune(0.7)
    expect(imageCount(moderate)).toBe(3) // 2 previews + reference

    const severe = historyWithPreviews(6)
    severe.prune(0.9)
    expect(imageCount(severe)).toBe(2) // 1 preview + reference
  })

  it('is idempotent — a second pass reports nothing new', () => {
    const history = historyWithPreviews(6)
    expect(history.prune(0)).toContain('Dropped 3')
    expect(history.prune(0)).toBeNull()
  })
})

describe('History.toArray cache breakpoints', () => {
  const marks = (history: History): number[] =>
    history
      .toArray(true)
      .map((m, i) => (Array.isArray(m.content) && m.content.some((p) => p.cache_control) ? i : -1))
      .filter((i) => i >= 0)

  it('adds nothing unless asked', () => {
    const history = historyWithPreviews(6)
    history.prune(0)
    for (const message of history.toArray()) {
      if (Array.isArray(message.content)) {
        expect(message.content.some((p) => p.cache_control)).toBe(false)
      }
    }
  })

  it('marks the system prompt, promoting its string body to a part', () => {
    const history = historyWithPreviews(1)
    const system = history.toArray(true)[0]
    expect(system.content).toEqual([
      { type: 'text', text: 'system', cache_control: { type: 'ephemeral' } },
    ])
  })

  it('leaves the stored messages clean, so marks cannot accumulate', () => {
    const history = historyWithPreviews(1)
    history.toArray(true)
    history.toArray(true)
    expect(history.toArray()[0].content).toBe('system')
  })

  it('adds a second breakpoint at the pruning frontier once previews decay', () => {
    const history = historyWithPreviews(6)
    expect(marks(history)).toEqual([0]) // nothing pruned yet — system only

    history.prune(0)
    const after = marks(history)
    expect(after).toHaveLength(2)
    expect(after[0]).toBe(0)

    // The frontier is the newest collapsed preview: everything at or before it is now frozen, so a
    // breakpoint there survives the next prune, which the rolling tail marker would not.
    const frontier = history.toArray()[after[1]]
    expect(frontier).toMatchObject({ role: 'user' })
    expect(history.toArray(true)[after[1]].content).toEqual([
      { type: 'text', text: '[preview 3 dropped]', cache_control: { type: 'ephemeral' } },
    ])
  })

  it('advances the frontier as pruning walks forward', () => {
    const history = historyWithPreviews(6)
    history.prune(0)
    const first = marks(history)[1]

    history.push({ role: 'assistant', content: 'turn 7' })
    history.pushPreview(parts('p7'), '[preview 7 dropped]')
    history.prune(0)

    expect(marks(history)[1]).toBeGreaterThan(first)
  })
})

describe('buildFirstUserMessage', () => {
  it('sends a plain string when there are no references', () => {
    expect(buildFirstUserMessage('draw a cat', [], true)).toEqual({
      role: 'user',
      content: 'draw a cat',
    })
  })

  it('omits images for a model that cannot see them', () => {
    const message = buildFirstUserMessage('draw a cat', ['data:image/png;base64,AAA'], false)
    expect(message.content).toBe('draw a cat')
  })

  it('attaches every reference for a vision model', () => {
    const message = buildFirstUserMessage('draw a cat', ['data:a', 'data:b'], true)
    expect(message.content).toEqual([
      { type: 'text', text: 'draw a cat' },
      { type: 'image_url', image_url: { url: 'data:a' } },
      { type: 'image_url', image_url: { url: 'data:b' } },
    ])
  })
})
