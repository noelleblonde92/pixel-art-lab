import type { Response } from 'express'

/** Open an SSE response with buffering disabled, so events reach the browser as they happen. */
export function openSse(res: Response): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.write(': open\n\n')
  res.flushHeaders?.()
}

export function writeSse(res: Response, data: unknown): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

export function writeSseComment(res: Response, text: string): void {
  res.write(`: ${text}\n\n`)
}
