import { describe, expect, it } from 'vitest'
import { consume, type StreamHandlers } from './stream.js'

/** Feed the parser arbitrary byte splits, to prove frames surviving chunk boundaries. */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

function collector(): StreamHandlers & { text: string; reasoning: string } {
  const sink = {
    text: '',
    reasoning: '',
    onText(delta: string) {
      sink.text += delta
    },
    onReasoning(delta: string) {
      sink.reasoning += delta
    },
  }
  return sink
}

const frame = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`

describe('consume', () => {
  it('accumulates text deltas and reports usage from the final chunk', async () => {
    const sink = collector()
    const result = await consume(
      streamOf([
        frame({ choices: [{ delta: { content: 'Hello' } }] }),
        frame({ choices: [{ delta: { content: ' world' } }] }),
        frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
        frame({
          choices: [],
          usage: {
            prompt_tokens: 120,
            completion_tokens: 8,
            cost: 0.0031,
            completion_tokens_details: { reasoning_tokens: 40 },
          },
        }),
        'data: [DONE]\n\n',
      ]),
      sink,
    )

    expect(result.text).toBe('Hello world')
    expect(sink.text).toBe('Hello world')
    expect(result.finishReason).toBe('stop')
    expect(result.usage).toEqual({
      promptTokens: 120,
      completionTokens: 8,
      reasoningTokens: 40,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      cost: 0.0031,
    })
  })

  it('reports cache reads and writes when the provider sends them', async () => {
    const result = await consume(
      streamOf([
        frame({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }),
        frame({
          choices: [],
          usage: {
            prompt_tokens: 10339,
            completion_tokens: 60,
            cost: 0.0009,
            prompt_tokens_details: { cached_tokens: 10318, cache_write_tokens: 21 },
          },
        }),
        'data: [DONE]\n\n',
      ]),
      collector(),
    )

    // cached_tokens is a subset of prompt_tokens, not an addition to it.
    expect(result.usage.promptTokens).toBe(10339)
    expect(result.usage.cachedTokens).toBe(10318)
    expect(result.usage.cacheWriteTokens).toBe(21)
  })

  it('reassembles tool call arguments split across many chunks', async () => {
    const result = await consume(
      streamOf([
        frame({
          choices: [
            { delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'draw_line' } }] } },
          ],
        }),
        frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"x1":' } }] } }] }),
        frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1,"y1":2}' } }] } }] }),
        'data: [DONE]\n\n',
      ]),
      collector(),
    )

    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0]).toMatchObject({ id: 'call_a', type: 'function' })
    expect(JSON.parse(result.toolCalls[0].function.arguments)).toEqual({ x1: 1, y1: 2 })
  })

  it('keeps parallel tool calls separate and ordered by index', async () => {
    const result = await consume(
      streamOf([
        frame({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 1, id: 'b', function: { name: 'second', arguments: '{"b":' } },
                  { index: 0, id: 'a', function: { name: 'first', arguments: '{"a":' } },
                ],
              },
            },
          ],
        }),
        frame({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: '1}' } },
                  { index: 1, function: { arguments: '2}' } },
                ],
              },
            },
          ],
        }),
      ]),
      collector(),
    )

    expect(result.toolCalls.map((c) => c.function.name)).toEqual(['first', 'second'])
    expect(result.toolCalls.map((c) => c.function.arguments)).toEqual(['{"a":1}', '{"b":2}'])
  })

  it('survives a frame split mid-JSON across chunk boundaries', async () => {
    const payload = frame({ choices: [{ delta: { content: 'split me' } }] })
    const cut = Math.floor(payload.length / 2)
    const result = await consume(
      streamOf([payload.slice(0, cut), payload.slice(cut)]),
      collector(),
    )
    expect(result.text).toBe('split me')
  })

  it('reads reasoning from both the flat field and reasoning_details', async () => {
    const sink = collector()
    const result = await consume(
      streamOf([
        frame({ choices: [{ delta: { reasoning: 'first ' } }] }),
        frame({ choices: [{ delta: { reasoning_details: [{ text: 'second' }] } }] }),
      ]),
      sink,
    )
    expect(result.reasoning).toBe('first second')
    expect(sink.reasoning).toBe('first second')
  })

  it('ignores keepalive comments and unparseable frames', async () => {
    const result = await consume(
      streamOf([
        ': OPENROUTER PROCESSING\n\n',
        'data: {not json\n\n',
        frame({ choices: [{ delta: { content: 'ok' } }] }),
      ]),
      collector(),
    )
    expect(result.text).toBe('ok')
  })

  it('drops tool call fragments that never received a name', async () => {
    const result = await consume(
      streamOf([frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }] } }] })]),
      collector(),
    )
    expect(result.toolCalls).toEqual([])
  })
})
