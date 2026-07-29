import { describe, expect, it } from 'vitest'
import { drawPixels } from './drawPixels.js'
import type { PixelMcp } from './client.js'

interface Call {
  name: string
  args: Record<string, unknown>
}

/**
 * A stand-in for pixel-mcp that reproduces the behaviour this wrapper exists to hide: a layer holds
 * one cel, `draw_pixels` clips to that cel's bounding box while still counting every pixel it was
 * handed, and any drawing tool with a real rect grows the box.
 */
function fakeMcp(opts: { width?: number; height?: number; infoFails?: boolean } = {}) {
  const width = opts.width ?? 16
  const height = opts.height ?? 16
  const canvas = new Map<string, string>()
  /** null until a cel exists, matching a fresh layer. */
  let cel: { x0: number; y0: number; x1: number; y1: number } | null = null
  const calls: Call[] = []

  const grow = (x: number, y: number) => {
    cel = cel
      ? {
          x0: Math.min(cel.x0, x),
          y0: Math.min(cel.y0, y),
          x1: Math.max(cel.x1, x),
          y1: Math.max(cel.y1, y),
        }
      : { x0: x, y0: y, x1: x, y1: y }
  }
  const inCel = (x: number, y: number) =>
    cel !== null && x >= cel.x0 && x <= cel.x1 && y >= cel.y0 && y <= cel.y1

  const mcp = {
    async callTool(name: string, args: Record<string, unknown>) {
      calls.push({ name, args })

      if (name === 'get_sprite_info') {
        if (opts.infoFails) return { ok: false, text: 'no such sprite' }
        return { ok: true, text: JSON.stringify({ width, height, layers: ['Layer 1'] }) }
      }

      if (name === 'draw_rectangle') {
        const x = Number(args.x)
        const y = Number(args.y)
        const color = String(args.color)
        // A rectangle is canvas-accurate and always extends the cel, even when erasing.
        grow(x, y)
        if (color.toUpperCase().endsWith('00')) canvas.delete(`${x},${y}`)
        else canvas.set(`${x},${y}`, color)
        return { ok: true, text: JSON.stringify({ success: true }) }
      }

      if (name === 'draw_pixels') {
        const pixels = (args.pixels ?? []) as { x: number; y: number; color: string }[]
        for (const p of pixels) {
          if (inCel(p.x, p.y)) canvas.set(`${p.x},${p.y}`, p.color)
        }
        // The lie at the heart of this: every pixel is counted, clipped or not.
        return { ok: true, text: JSON.stringify({ pixels_drawn: pixels.length }) }
      }

      if (name === 'get_pixels') {
        const x = Number(args.x)
        const y = Number(args.y)
        const color = canvas.get(`${x},${y}`)
        return {
          ok: true,
          text: JSON.stringify({
            pixels: [{ x, y, color: color ? `${color.slice(0, 7)}FF` : '#00000000' }],
            total_pixels: 1,
          }),
        }
      }

      return { ok: true, text: '{}' }
    },
  }

  return { mcp: mcp as unknown as PixelMcp, canvas, calls }
}

const req = (pixels: { x: number; y: number; color: string }[]) => ({
  sprite_path: 'sprites/knight.aseprite',
  layer_name: 'Layer 1',
  frame_number: 1,
  pixels,
})

describe('drawPixels', () => {
  it('the fake still reproduces the bug when called raw', async () => {
    // Guards the fixture itself: if pixel-mcp's clipping stops being modelled here, every
    // assertion below passes for the wrong reason.
    const { mcp, canvas } = fakeMcp()
    await mcp.callTool('draw_rectangle', {
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      color: '#00000001',
      filled: true,
    })

    const res = await mcp.callTool('draw_pixels', req([{ x: 14, y: 3, color: '#ff0000' }]))

    expect(JSON.parse(res.text)).toEqual({ pixels_drawn: 1 })
    expect(canvas.has('14,3')).toBe(false)
  })

  it('lands pixels at canvas coordinates on a layer that has never been drawn on', async () => {
    // The e32b48be failure: on an empty layer every pixel used to be clipped into nothing.
    const { mcp, canvas } = fakeMcp()

    const res = await drawPixels(
      mcp,
      req([
        { x: 14, y: 3, color: '#ff0000' },
        { x: 2, y: 12, color: '#00ff00' },
      ]),
    )

    expect(res.ok).toBe(true)
    expect(canvas.get('14,3')).toBe('#ff0000')
    expect(canvas.get('2,12')).toBe('#00ff00')
  })

  it('leaves no pins behind for apply_outline to find', async () => {
    // An alpha-1 pin reads as opaque to apply_outline, which then paints a blob around it.
    const { mcp, canvas } = fakeMcp({ width: 16, height: 16 })

    await drawPixels(mcp, req([{ x: 8, y: 8, color: '#ffffff' }]))

    expect(canvas.has('0,0')).toBe(false)
    expect(canvas.has('15,15')).toBe(false)
    expect(canvas.get('8,8')).toBe('#ffffff')
  })

  it('keeps the model’s own pixel when it draws on a corner', async () => {
    const { mcp, canvas } = fakeMcp({ width: 16, height: 16 })

    await drawPixels(
      mcp,
      req([
        { x: 0, y: 0, color: '#112233' },
        { x: 15, y: 15, color: '#445566' },
      ]),
    )

    expect(canvas.get('0,0')).toBe('#112233')
    expect(canvas.get('15,15')).toBe('#445566')
  })

  it('does not disturb existing art at a corner', async () => {
    const { mcp, canvas, calls } = fakeMcp({ width: 16, height: 16 })
    await mcp.callTool('draw_rectangle', {
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      color: '#abcdef',
      filled: true,
    })
    calls.length = 0

    await drawPixels(mcp, req([{ x: 9, y: 9, color: '#ffffff' }]))

    expect(canvas.get('0,0')).toBe('#abcdef')
    // An occupied corner already anchors the cel, so there is nothing to pin there.
    expect(calls.filter((c) => c.name === 'draw_rectangle' && c.args.x === 0)).toHaveLength(0)
  })

  it('reports off-canvas pixels instead of dropping them silently', async () => {
    const { mcp, canvas } = fakeMcp({ width: 16, height: 16 })

    const res = await drawPixels(
      mcp,
      req([
        { x: 4, y: 4, color: '#ff0000' },
        { x: 20, y: 4, color: '#ff0000' },
        { x: -1, y: 2, color: '#ff0000' },
      ]),
    )

    const result = res.result as { pixels_drawn: number; skipped_off_canvas: number; note: string }
    expect(result.pixels_drawn).toBe(1)
    expect(result.skipped_off_canvas).toBe(2)
    expect(result.note).toContain('16x16')
    expect(canvas.get('4,4')).toBe('#ff0000')
  })

  it('draws nothing and still explains itself when every pixel is off-canvas', async () => {
    const { mcp, calls } = fakeMcp({ width: 16, height: 16 })

    const res = await drawPixels(mcp, req([{ x: 99, y: 99, color: '#ff0000' }]))

    expect((res.result as { pixels_drawn: number }).pixels_drawn).toBe(0)
    expect((res.result as { skipped_off_canvas: number }).skipped_off_canvas).toBe(1)
    expect(calls.some((c) => c.name === 'draw_pixels')).toBe(false)
  })

  it('still pins from the requested bounds when the sprite size is unavailable', async () => {
    const { mcp, canvas } = fakeMcp({ infoFails: true })

    const res = await drawPixels(
      mcp,
      req([
        { x: 3, y: 7, color: '#ff0000' },
        { x: 11, y: 2, color: '#00ff00' },
      ]),
    )

    expect(res.ok).toBe(true)
    expect(canvas.get('3,7')).toBe('#ff0000')
    expect(canvas.get('11,2')).toBe('#00ff00')
  })

  it('forwards malformed arguments so pixel-mcp owns the error message', async () => {
    const { mcp, calls } = fakeMcp()

    await drawPixels(mcp, { sprite_path: 'sprites/knight.aseprite', layer_name: 'Layer 1' })

    expect(calls).toEqual([
      { name: 'draw_pixels', args: { sprite_path: 'sprites/knight.aseprite', layer_name: 'Layer 1' } },
    ])
  })

  it('cleans up its pins even when the draw fails', async () => {
    const { mcp, canvas } = fakeMcp({ width: 16, height: 16 })
    const inner = mcp.callTool.bind(mcp)
    mcp.callTool = async (name: string, args: Record<string, unknown>) => {
      if (name === 'draw_pixels') return { ok: false, text: 'layer is locked' }
      return inner(name, args)
    }

    const res = await drawPixels(mcp, req([{ x: 5, y: 5, color: '#ff0000' }]))

    expect(res.ok).toBe(false)
    expect(canvas.has('0,0')).toBe(false)
    expect(canvas.has('15,15')).toBe(false)
  })
})
