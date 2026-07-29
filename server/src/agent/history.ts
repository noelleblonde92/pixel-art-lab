import { config } from '../config.js'
import type { ChatMessage, ContentPart } from '../openrouter/stream.js'

/** Index of the system message. Its content never changes, so it anchors the run's static prefix. */
const SYSTEM_INDEX = 0

/**
 * Conversation history with preview-image pruning.
 *
 * A 512px preview costs roughly 1-2k image tokens. Forty iterations of them will exhaust any context
 * window and cost real money, so only the most recent previews stay at full fidelity — older ones
 * decay to a one-line text placeholder. The model has already acted on those; what it needs is the
 * current state, not a photo album.
 *
 * User-supplied reference images are never pruned: they are the target, and they stay relevant to
 * the last turn.
 */
export class History {
  private messages: ChatMessage[] = []
  /** Indices of preview messages, oldest first. Reference images are deliberately absent. */
  private previewIndices: number[] = []
  private pruned = new Set<number>()

  constructor(system: string, firstUser: ChatMessage) {
    this.messages.push({ role: 'system', content: system })
    this.messages.push(firstUser)
  }

  push(message: ChatMessage): void {
    this.messages.push(message)
  }

  /**
   * Add a preview image as a user message — the portable way to get an image into any model.
   *
   * `description` names the image without saying why it went away, because there are two reasons and
   * they mean opposite things: age, or the state having been undone. `collapse` supplies the reason.
   */
  pushPreview(parts: ContentPart[], description: string, spritePath: string): void {
    this.messages.push({ role: 'user', content: parts })
    this.previewIndices.push(this.messages.length - 1)
    this.descriptions.set(this.messages.length - 1, description)
    this.previewSprites.set(this.messages.length - 1, spritePath)
  }

  private descriptions = new Map<number, string>()
  /** Which sprite each preview pictures, so an undo of one sprite cannot claim another's previews. */
  private previewSprites = new Map<number, string>()

  /** Replace a preview image with a line of text saying what it was and why it is gone. */
  private collapse(index: number, reason: string): void {
    const description = this.descriptions.get(index) ?? 'an earlier preview'
    this.messages[index] = { role: 'user', content: `[${description} — ${reason}]` }
    this.pruned.add(index)
  }

  /**
   * Collapse older previews to text.
   *
   * `contextRatio` is the last turn's prompt_tokens over the model's context length — free and
   * accurate, since OpenRouter reports real token counts. Under pressure, keep fewer.
   */
  prune(contextRatio: number): string | null {
    let keep: number = config.keptPreviews
    if (contextRatio > config.contextPressureThreshold) keep = 2
    if (contextRatio > 0.8) keep = 1

    const stale = this.previewIndices.slice(0, Math.max(0, this.previewIndices.length - keep))
    let dropped = 0

    for (const index of stale) {
      if (this.pruned.has(index)) continue
      this.collapse(index, 'image dropped to save context')
      dropped++
    }

    if (!dropped) return null
    return `Dropped ${dropped} older preview image${dropped === 1 ? '' : 's'} from context to stay within the window.`
  }

  /**
   * Collapse the previews of states an `undo` has just thrown away.
   *
   * Previews are pushed one per iteration in order, so iterations `from + 1` through `through`
   * picture a canvas that no longer exists. Leaving them is worse than leaving nothing: the newest is
   * the most recent image the model can see, and it shows precisely the state it asked to be rid of.
   * A note in the tool result cannot compete with an image — that is the cel trap's lesson — so the
   * image goes. The line of text stays, because the mistake is still worth remembering and a model
   * that forgets it will draw it again.
   *
   * The range is closed at both ends rather than running to the newest preview, because a model that
   * undoes and then previews to confirm the revert does both inside one turn. That confirming image
   * is the only accurate one in the conversation, and an open-ended drop would take it.
   *
   * Scoped to one sprite for the same kind of reason: iterations are numbered globally across the
   * run, but an undo rewinds a single file, so a preview of a *different* sprite inside the range is
   * still true of its canvas and stays.
   */
  dropUndonePreviews(spritePath: string, from: number, through: number): number {
    let dropped = 0
    // Both bounds are 1-based iteration numbers, and the restored preview is still true of the
    // canvas — so the slice starts *at* `from`, which is the ordinal after it.
    for (const index of this.previewIndices.slice(Math.max(0, from), Math.max(0, through))) {
      if (this.pruned.has(index)) continue
      if (this.previewSprites.get(index) !== spritePath) continue
      this.collapse(index, 'you undid this state; it is not what is on the canvas, image removed')
      dropped++
    }
    return dropped
  }

  /**
   * The highest index that will never be rewritten again.
   *
   * Collapsing a preview rewrites it *in place*, and any edit invalidates every cache breakpoint at
   * or after it — so on a turn where one fired, the rolling tail breakpoint from the previous turn is
   * worthless. What survives is the end of the *contiguous* run of collapsed previews: nothing before
   * it can change again, so a breakpoint there holds.
   *
   * The contiguity is the whole point and is easy to lose. Age-based pruning alone only ever walks
   * forward, which made "the newest collapsed index" an equivalent and simpler answer — but
   * `dropUndonePreviews` collapses the *newest* previews while older ones are still live images, and
   * under that answer the breakpoint would land past previews `prune` is still going to rewrite.
   */
  private cacheFrontier(): number | null {
    let frontier: number | null = null
    for (const index of this.previewIndices) {
      if (!this.pruned.has(index)) break
      frontier = index
    }
    return frontier
  }

  /**
   * The messages to send.
   *
   * With `cacheBreakpoints`, the two static markers are applied to a shallow copy — the stored
   * messages stay clean so the marks cannot accumulate across turns or leak into the transcript.
   */
  toArray(cacheBreakpoints = false): ChatMessage[] {
    if (!cacheBreakpoints) return this.messages

    const marked = this.messages.slice()
    // The system prompt is built once per run and never edited. Tools serialise ahead of it, so one
    // breakpoint here covers the entire tool menu as well — the largest fixed block in the request.
    marked[SYSTEM_INDEX] = withCacheControl(marked[SYSTEM_INDEX])

    const frontier = this.cacheFrontier()
    if (frontier !== null) marked[frontier] = withCacheControl(marked[frontier])

    return marked
  }

  get length(): number {
    return this.messages.length
  }
}

/**
 * Copy a message with a cache breakpoint on its final content block.
 *
 * The marker only rides on content *parts*, so a string body is promoted to a one-element array
 * first. Roles that cannot carry parts portably — assistant turns and tool results — are returned
 * untouched rather than reshaped into something a provider might reject.
 */
function withCacheControl(message: ChatMessage): ChatMessage {
  if (message.role !== 'system' && message.role !== 'user') return message

  const parts: ContentPart[] =
    typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : message.content.slice()

  const last = parts[parts.length - 1]
  if (!last) return message

  parts[parts.length - 1] = { ...last, cache_control: { type: 'ephemeral' } }
  return { ...message, content: parts }
}

/** Build the opening user message: the prompt, plus any reference images the model can actually see. */
export function buildFirstUserMessage(
  prompt: string,
  referenceDataUris: string[],
  hasVision: boolean,
): ChatMessage {
  if (!referenceDataUris.length || !hasVision) {
    return { role: 'user', content: prompt }
  }

  const parts: ContentPart[] = [{ type: 'text', text: prompt }]
  for (const url of referenceDataUris) {
    parts.push({ type: 'image_url', image_url: { url } })
  }
  return { role: 'user', content: parts }
}
