import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createWriteStream, type WriteStream } from 'node:fs'
import path from 'node:path'
import { config } from '../config.js'

export interface McpToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/**
 * One pixel-mcp child process, wrapped.
 *
 * The server is stdio-only and stateless — every call reopens the .aseprite from disk, mutates it,
 * and saves. We run one process per run so a crash takes down exactly one run, and so the process
 * dies with the run rather than accumulating.
 */
export class PixelMcp {
  private client: Client
  private log: WriteStream
  private closed = false
  /** Set when the transport dies unexpectedly, so callers get a useful message instead of a hang. */
  private failure: Error | null = null

  private constructor(client: Client, log: WriteStream) {
    this.client = client
    this.log = log
  }

  static async start(runDir: string): Promise<PixelMcp> {
    const log = createWriteStream(path.join(runDir, 'mcp.log'), { flags: 'a' })

    const transport = new StdioClientTransport({
      command: config.mcpBin,
      // pixel-mcp writes its logs to stderr; stdout is reserved for JSON-RPC framing.
      stderr: 'pipe',
    })

    const client = new Client({ name: 'pixel-art-lab', version: '0.1.0' })
    const mcp = new PixelMcp(client, log)

    transport.onerror = (err) => {
      mcp.failure ??= err instanceof Error ? err : new Error(String(err))
      log.write(`[transport error] ${String(err)}\n`)
    }
    transport.onclose = () => {
      if (!mcp.closed) {
        mcp.failure ??= new Error('pixel-mcp exited unexpectedly (see mcp.log)')
      }
    }

    await client.connect(transport)
    transport.stderr?.on('data', (chunk: Buffer) => log.write(chunk))

    return mcp
  }

  async listTools(): Promise<McpToolDef[]> {
    const res = await this.client.listTools()
    return res.tools.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: (t.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
    }))
  }

  /**
   * Call a tool. Resolves with the server's text payload, or rejects on transport failure/timeout.
   *
   * Tool-level errors (bad coordinates, missing layer) come back as `isError` content rather than a
   * rejection — the caller turns those into tool results the model can read and correct.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
    if (this.failure) throw this.failure

    const result = await this.client.callTool(
      { name, arguments: args },
      undefined,
      { timeout: config.toolTimeoutMs },
    )

    const content = Array.isArray(result.content) ? result.content : []
    const text = content
      .map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : ''))
      .filter(Boolean)
      .join('\n')

    // Some tools answer with a structured payload and no text block.
    const body = text || (result.structuredContent ? JSON.stringify(result.structuredContent) : '{}')
    return { ok: result.isError !== true, text: body }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    try {
      await this.client.close()
    } catch {
      // The child may already be gone; nothing useful to do.
    }
    this.log.end()
  }
}
