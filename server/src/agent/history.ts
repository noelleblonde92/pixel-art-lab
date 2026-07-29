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

  /** Add a preview image as a user message — the portable way to get an image into any model. */
  pushPreview(parts: ContentPart[], placeholder: string): void {
    this.messages.push({ role: 'user', content: parts })
    this.previewIndices.push(this.messages.length - 1)
    this.placeholders.set(this.messages.length - 1, placeholder)
  }

  private placeholders = new Map<number, string>()

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
      const placeholder = this.placeholders.get(index) ?? '[earlier preview image removed]'
      this.messages[index] = { role: 'user', content: placeholder }
      this.pruned.add(index)
      dropped++
    }

    if (!dropped) return null
    return `Dropped ${dropped} older preview image${dropped === 1 ? '' : 's'} from context to stay within the window.`
  }

  /**
   * The highest index that will never be rewritten again.
   *
   * Pruning collapses previews *in place*, and any edit invalidates every cache breakpoint at or
   * after it — so on a turn where `prune` fired, the rolling tail breakpoint from the previous turn
   * is worthless. But pruning only ever walks forward: once a preview has decayed to text it is
   * frozen, and every preview before it has decayed too. That makes the newest pruned index a
   * permanently stable boundary, and a breakpoint there survives the invalidation.
   */
  private cacheFrontier(): number | null {
    let frontier: number | null = null
    for (const index of this.pruned) {
      if (frontier === null || index > frontier) frontier = index
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
