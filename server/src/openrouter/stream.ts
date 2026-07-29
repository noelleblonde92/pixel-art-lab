import { config } from '../config.js'
import type { ReasoningEffort } from '../types.js'
import type { FunctionTool } from '../mcp/toolset.js'

export type ChatMessage =
  | { role: 'system'; content: string | ContentPart[] }
  | { role: 'user'; content: string | ContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCallPayload[] }
  | { role: 'tool'; tool_call_id: string; content: string }

/**
 * `cache_control` marks an explicit cache breakpoint: everything up to and including this block is
 * cacheable. Anthropic and Alibaba cache *only* at these markers; OpenRouter converts them to the
 * native format for OpenAI models that support explicit caching.
 */
export type ContentPart =
  | { type: 'text'; text: string; cache_control?: CacheControl }
  | { type: 'image_url'; image_url: { url: string }; cache_control?: CacheControl }

export interface CacheControl {
  type: 'ephemeral'
}

export interface ToolCallPayload {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface Usage {
  promptTokens: number
  completionTokens: number
  reasoningTokens: number
  /** Prompt tokens served from cache. Included in `promptTokens`, charged at a fraction of it. */
  cachedTokens: number
  /** Prompt tokens written to cache this turn. Only providers with explicit caching report these. */
  cacheWriteTokens: number
  cost: number
}

export interface TurnResult {
  text: string
  reasoning: string
  toolCalls: ToolCallPayload[]
  usage: Usage
  finishReason: string
}

export interface StreamHandlers {
  onText: (delta: string) => void
  onReasoning: (delta: string) => void
}

export interface TurnOptions {
  model: string
  messages: ChatMessage[]
  tools: FunctionTool[]
  effort?: ReasoningEffort
  sendReasoning: boolean
  /** Ask for a rolling cache breakpoint at the tail of the prompt. See `streamOnce`. */
  cacheBreakpoints: boolean
  signal: AbortSignal
}

/** Non-retryable: the request itself is wrong, or we are out of money. */
export class FatalOpenRouterError extends Error {}

/**
 * One model round-trip, streamed.
 *
 * Retries transient failures with backoff. 402 and 400 are surfaced immediately — no amount of
 * retrying fixes an empty account or a rejected schema.
 */
export async function runTurn(
  opts: TurnOptions,
  handlers: StreamHandlers,
): Promise<TurnResult> {
  const delays = [1000, 2000, 4000, 8000]

  for (let attempt = 0; ; attempt++) {
    try {
      return await streamOnce(opts, handlers)
    } catch (err) {
      if (err instanceof FatalOpenRouterError) throw err
      if (opts.signal.aborted) throw err
      if (attempt >= delays.length) throw err
      await sleep(delays[attempt], opts.signal)
    }
  }
}

async function streamOnce(opts: TurnOptions, handlers: StreamHandlers): Promise<TurnResult> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    tools: opts.tools,
    stream: true,
    // Ask for token counts and the real charged cost in the final chunk.
    usage: { include: true },
  }

  // A top-level directive tells OpenRouter to put a breakpoint on the last cacheable block of the
  // request — a rolling tail marker, renewed every turn, which is exactly what a growing agentic
  // conversation wants. History places the two *static* breakpoints (system prompt, pruning
  // frontier) that this one cannot express.
  if (opts.cacheBreakpoints) {
    body.cache_control = { type: 'ephemeral' }
  }

  // Only send reasoning to models that advertise it; others 400 on the unknown field.
  if (opts.sendReasoning && opts.effort && opts.effort !== 'none') {
    body.reasoning = { effort: opts.effort }
  } else if (opts.sendReasoning && opts.effort === 'none') {
    body.reasoning = { enabled: false }
  }

  const res = await fetch(`${config.openRouterBase}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.openRouterKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'http://localhost',
      'X-Title': 'Pixel Art Lab',
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  })

  if (!res.ok) {
    const detail = await res.text()
    if (res.status === 402) {
      throw new FatalOpenRouterError(`OpenRouter says the account is out of credits (402): ${detail}`)
    }
    if (res.status === 400 || res.status === 401 || res.status === 404) {
      throw new FatalOpenRouterError(`OpenRouter rejected the request (${res.status}): ${detail}`)
    }
    throw new Error(`OpenRouter error ${res.status}: ${detail}`)
  }
  if (!res.body) throw new Error('OpenRouter returned no response body')

  return await consume(res.body, handlers)
}

/**
 * Parse the SSE stream and rebuild the assistant turn.
 *
 * Tool call arguments arrive as fragments spread across many chunks, keyed by `index` rather than by
 * id, and a single turn can open several calls at once. Accumulate per index and only assemble at
 * the end.
 */
export async function consume(
  stream: ReadableStream<Uint8Array>,
  handlers: StreamHandlers,
): Promise<TurnResult> {
  const decoder = new TextDecoder()
  const reader = stream.getReader()

  let buffer = ''
  let text = ''
  let reasoning = ''
  let finishReason = ''
  const usage: Usage = {
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
  }
  const partials = new Map<number, { id: string; name: string; args: string }>()

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      // Frames are separated by a blank line; a frame may straddle chunk boundaries.
      let sep: number
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, sep)
        buffer = buffer.slice(sep + 2)

        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (!payload || payload === '[DONE]') continue

          let chunk: StreamChunk
          try {
            chunk = JSON.parse(payload) as StreamChunk
          } catch {
            continue // OpenRouter emits ": OPENROUTER PROCESSING" keepalives and the odd partial
          }

          if (chunk.usage) {
            usage.promptTokens = chunk.usage.prompt_tokens ?? 0
            usage.completionTokens = chunk.usage.completion_tokens ?? 0
            usage.reasoningTokens = chunk.usage.completion_tokens_details?.reasoning_tokens ?? 0
            usage.cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0
            usage.cacheWriteTokens = chunk.usage.prompt_tokens_details?.cache_write_tokens ?? 0
            usage.cost = chunk.usage.cost ?? 0
          }

          const choice = chunk.choices?.[0]
          if (!choice) continue
          if (choice.finish_reason) finishReason = choice.finish_reason

          const delta = choice.delta
          if (!delta) continue

          if (typeof delta.content === 'string' && delta.content) {
            text += delta.content
            handlers.onText(delta.content)
          }

          const reasoningDelta = extractReasoning(delta)
          if (reasoningDelta) {
            reasoning += reasoningDelta
            handlers.onReasoning(reasoningDelta)
          }

          for (const call of delta.tool_calls ?? []) {
            const index = call.index ?? 0
            const entry = partials.get(index) ?? { id: '', name: '', args: '' }
            if (call.id) entry.id = call.id
            if (call.function?.name) entry.name = call.function.name
            if (call.function?.arguments) entry.args += call.function.arguments
            partials.set(index, entry)
          }
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  const toolCalls: ToolCallPayload[] = [...partials.entries()]
    .sort(([a], [b]) => a - b)
    .filter(([, v]) => v.name)
    .map(([index, v]) => ({
      id: v.id || `call_${index}`,
      type: 'function' as const,
      function: { name: v.name, arguments: v.args || '{}' },
    }))

  return { text, reasoning, toolCalls, usage, finishReason }
}

/** Providers disagree on where reasoning lands, so check every shape OpenRouter forwards. */
function extractReasoning(delta: Delta): string {
  if (typeof delta.reasoning === 'string' && delta.reasoning) return delta.reasoning

  let out = ''
  for (const detail of delta.reasoning_details ?? []) {
    if (typeof detail?.text === 'string') out += detail.text
    else if (typeof detail?.summary === 'string') out += detail.summary
  }
  return out
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

interface Delta {
  content?: string | null
  reasoning?: string | null
  reasoning_details?: Array<{ text?: string; summary?: string }>
  tool_calls?: Array<{
    index?: number
    id?: string
    function?: { name?: string; arguments?: string }
  }>
}

interface StreamChunk {
  choices?: Array<{ delta?: Delta; finish_reason?: string | null }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    cost?: number
    completion_tokens_details?: { reasoning_tokens?: number }
    prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number }
  }
}
