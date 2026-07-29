import { describe, expect, it } from 'vitest'
import { History, buildFirstUserMessage } from './history.js'
import type { ContentPart } from '../openrouter/stream.js'

const parts = (label: string): ContentPart[] => [
  { type: 'text', text: label },
  { type: 'image_url', image_url: { url: `data:image/png;base64,${label}` } },
]

const SPRITE = 'sprites/knight.aseprite'

function historyWithPreviews(count: number): History {
  const history = new History('system', buildFirstUserMessage('prompt', ['data:image/png;base64,REF'], true))
  for (let i = 1; i <= count; i++) {
    history.push({ role: 'assistant', content: `turn ${i}` })
    history.pushPreview(parts(`p${i}`), `preview ${i}`, SPRITE)
  }
  return history
}

const AGED = 'image dropped to save context'
const UNDONE = 'you undid this state'

const textOf = (history: History): string[] =>
  history.toArray().filter((m) => typeof m.content === 'string').map((m) => m.content as string)

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

    const texts = textOf(history)
    expect(texts).toContain(`[preview 1 — ${AGED}]`)
    expect(texts).toContain(`[preview 3 — ${AGED}]`)
    expect(texts).not.toContain(`[preview 4 — ${AGED}]`)
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
      { type: 'text', text: `[preview 3 — ${AGED}]`, cache_control: { type: 'ephemeral' } },
    ])
  })

  it('advances the frontier as pruning walks forward', () => {
    const history = historyWithPreviews(6)
    history.prune(0)
    const first = marks(history)[1]

    history.push({ role: 'assistant', content: 'turn 7' })
    history.pushPreview(parts('p7'), 'preview 7', SPRITE)
    history.prune(0)

    expect(marks(history)[1]).toBeGreaterThan(first)
  })

  /**
   * The invariant undo could break. Collapsing the newest previews leaves a gap, and a frontier taken
   * as "the newest collapsed index" would sit past previews `prune` is still going to rewrite — which
   * is exactly the invalidation the second breakpoint exists to dodge.
   */
  it('keeps the frontier behind any preview that is still a live image', () => {
    const history = historyWithPreviews(6)
    history.dropUndonePreviews(SPRITE, 4, 6) // previews 5 and 6 collapse; 1-4 are still images

    expect(marks(history)).toEqual([0]) // no contiguous collapsed prefix yet, so system only

    history.prune(0) // now 1-3 collapse from age
    const after = marks(history)
    expect(after).toHaveLength(2)
    expect(history.toArray(true)[after[1]].content).toEqual([
      { type: 'text', text: `[preview 3 — ${AGED}]`, cache_control: { type: 'ephemeral' } },
    ])
  })
})

describe('History.dropUndonePreviews', () => {
  const undone = (n: number) => `[preview ${n} — ${UNDONE}; it is not what is on the canvas, image removed]`

  it('collapses the previews of states that were undone, and keeps the restored one', () => {
    const history = historyWithPreviews(4)
    expect(history.dropUndonePreviews(SPRITE, 2, 4)).toBe(2)

    // 2 surviving previews + the reference image
    expect(imageCount(history)).toBe(3)
    const texts = textOf(history)
    expect(texts).toContain(undone(3))
    expect(texts).toContain(undone(4))
  })

  it('leaves nothing to undo alone when the newest preview is the restored one', () => {
    const history = historyWithPreviews(3)
    expect(history.dropUndonePreviews(SPRITE, 3, 3)).toBe(0)
    expect(imageCount(history)).toBe(4)
  })

  /**
   * A model that undoes and then previews to confirm does both in one turn, and that confirming
   * image is the only accurate one left. An open-ended drop would take exactly the frame the model
   * needs, which is why the range has a top.
   */
  it('spares a preview taken after the undo in the same turn', () => {
    const history = historyWithPreviews(3)
    // The undo ran when 2 previews existed; preview 3 is the look at the restored canvas.
    expect(history.dropUndonePreviews(SPRITE, 1, 2)).toBe(1)

    const texts = textOf(history)
    expect(texts).toContain(undone(2))
    expect(texts).not.toContain(undone(3))
    expect(imageCount(history)).toBe(3) // previews 1 and 3, plus the reference
  })

  it('spares a preview taken between two undos in the same turn', () => {
    const history = historyWithPreviews(4)
    history.dropUndonePreviews(SPRITE, 1, 2) // first undo: 2 existed, back to 1
    history.dropUndonePreviews(SPRITE, 3, 4) // previewed (3), drew, previewed (4), undid back to 3

    const texts = textOf(history)
    expect(texts).toContain(undone(2))
    expect(texts).toContain(undone(4))
    expect(texts).not.toContain(undone(3))
    expect(imageCount(history)).toBe(3) // previews 1 and 3, plus the reference
  })

  /**
   * Iterations are numbered globally across the run, but an undo rewinds one file. A preview of a
   * different sprite inside the range is still true of its canvas, and telling the model "you undid
   * this state" about it would be false.
   */
  it('leaves another sprite’s previews alone inside the range', () => {
    const history = new History('system', buildFirstUserMessage('prompt', [], true))
    history.pushPreview(parts('p1'), 'preview 1', SPRITE) // iteration 1
    history.pushPreview(parts('p2'), 'preview 2', 'sprites/tree.aseprite') // iteration 2
    history.pushPreview(parts('p3'), 'preview 3', SPRITE) // iteration 3

    // Undo the knight back to iteration 1: the tree's preview 2 sits inside the range but stays.
    expect(history.dropUndonePreviews(SPRITE, 1, 3)).toBe(1)

    expect(imageCount(history)).toBe(2)
    const texts = textOf(history)
    expect(texts).toContain(undone(3))
    expect(texts).not.toContain(undone(2))
  })

  /** The reason it survives as text: a mistake the model cannot recall is a mistake it repeats. */
  it('names the state on the record even though the image is gone', () => {
    const history = historyWithPreviews(2)
    history.dropUndonePreviews(SPRITE, 1, 2)
    expect(textOf(history).some((t) => t.startsWith('[preview 2 —'))).toBe(true)
  })

  it('does not relabel a preview age had already collapsed', () => {
    const history = historyWithPreviews(6)
    history.prune(0) // 1-3 go for age
    history.dropUndonePreviews(SPRITE, 1, 6) // would otherwise reach 2-6

    const texts = textOf(history)
    expect(texts).toContain(`[preview 2 — ${AGED}]`)
    expect(texts).toContain(undone(5))
  })

  it('drops every image once the model undoes back to before the first preview', () => {
    const history = historyWithPreviews(3)
    expect(history.dropUndonePreviews(SPRITE, 0, 3)).toBe(3)
    expect(imageCount(history)).toBe(1) // the user's reference image, which is never pruned
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
