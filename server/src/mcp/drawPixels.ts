import type { PixelMcp } from './client.js'

/**
 * `draw_pixels`, made canvas-accurate.
 *
 * pixel-mcp's `draw_pixels` addresses the layer's *cel* rather than the canvas: coordinates are
 * relative to the cel's bounding box, and anything landing outside that box is discarded — while the
 * reply still counts it in `pixels_drawn`. Every other drawing tool is canvas-accurate, so this is
 * the single sharpest edge in the whole tool menu, and it fails silently in both directions.
 *
 * The documented workaround was to have the model pin the cel origin itself with a near-invisible
 * `#00000001` pixel at (0,0) before its first `draw_pixels` call. That is incomplete and actively
 * misleading: pinning the origin on an *empty* layer produces a 1x1 cel, so every subsequent pixel
 * is clipped. Run e32b48be did exactly that — followed the instruction, drew 340 pixels into a 1x1
 * cel, and rendered a blank canvas. A run that pinned *after* blocking in shapes got away with it
 * only because its rectangles had already grown the cel.
 *
 * So the pinning happens here instead, and it pins *both* corners — origin and far corner — which is
 * what actually guarantees the cel spans the canvas. The pins are removed again before returning, so
 * no other tool ever sees them: `apply_outline` treats an alpha-1 pixel as opaque and paints a blob
 * around it, and a leftover pin would otherwise follow the sprite into the gallery.
 *
 * Out-of-canvas pixels are reported back rather than silently dropped, because a tool result the
 * model can read is the only mechanism it has to self-correct.
 */

/** Alpha 1 of 255: invisible in a render, but opaque enough to define cel bounds. */
const PIN = '#00000001'
const ERASE = '#00000000'

interface Point {
  x: number
  y: number
}

export async function drawPixels(
  mcp: PixelMcp,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; result: unknown }> {
  const spritePath = typeof args.sprite_path === 'string' ? args.sprite_path : null
  const layerName = typeof args.layer_name === 'string' ? args.layer_name : null
  const pixels = Array.isArray(args.pixels) ? (args.pixels as unknown[]) : null

  // Malformed arguments go straight through: pixel-mcp's own validation message is the one the
  // model should see, and duplicating it here would mean two wordings for the same mistake.
  if (!spritePath || !layerName || !pixels) return forward(mcp, args)

  const frame = frameNumber(args.frame_number)
  const size = await spriteSize(mcp, spritePath)

  const inBounds: unknown[] = []
  let dropped = 0
  let firstDropped: Point | null = null

  for (const raw of pixels) {
    const at = pointOf(raw)
    // Unparseable entries are pixel-mcp's to reject, so they count as in-bounds and pass through.
    if (size && at && (at.x < 0 || at.y < 0 || at.x >= size.width || at.y >= size.height)) {
      dropped++
      firstDropped ??= at
      continue
    }
    inBounds.push(raw)
  }

  if (inBounds.length === 0) {
    return { ok: true, result: withBoundsNote({ pixels_drawn: 0 }, dropped, firstDropped, size) }
  }

  const corners = pinTargets(size, inBounds)
  const pinned: Point[] = []

  try {
    for (const corner of corners) {
      if (!(await isEmpty(mcp, spritePath, layerName, frame, corner))) continue
      const res = await paint(mcp, spritePath, layerName, frame, corner, PIN)
      if (res.ok) pinned.push(corner)
    }

    const res = await mcp.callTool('draw_pixels', { ...args, pixels: inBounds })
    if (!res.ok) return { ok: false, result: { error: res.text } }

    const parsed = safeParse(res.text)
    return { ok: true, result: withBoundsNote(parsed, dropped, firstDropped, size) }
  } finally {
    // A pin the model itself overwrote is now its own artwork, so only clear the ones still ours.
    const written = new Set(
      inBounds.map(pointOf).filter((p): p is Point => p !== null).map(key),
    )
    for (const corner of pinned) {
      if (written.has(key(corner))) continue
      // Best-effort: a failed cleanup leaves an invisible pixel, which must not mask the draw result.
      await paint(mcp, spritePath, layerName, frame, corner, ERASE).catch(() => {})
    }
  }
}

/**
 * The two points that force the cel to span everything about to be drawn.
 *
 * The canvas corners are the right answer whenever the dimensions are known. Without them, the
 * bounding box of the request still covers every requested pixel, since coordinates cannot be
 * negative — a weaker guarantee, but never a wrong one.
 */
function pinTargets(size: { width: number; height: number } | null, pixels: unknown[]): Point[] {
  let far: Point
  if (size) {
    far = { x: size.width - 1, y: size.height - 1 }
  } else {
    let x = 0
    let y = 0
    for (const raw of pixels) {
      const at = pointOf(raw)
      if (!at) continue
      x = Math.max(x, at.x)
      y = Math.max(y, at.y)
    }
    far = { x, y }
  }

  const origin = { x: 0, y: 0 }
  return key(far) === key(origin) ? [origin] : [origin, far]
}

/** True when nothing is drawn at this point — either outside the cel, or fully transparent. */
async function isEmpty(
  mcp: PixelMcp,
  spritePath: string,
  layerName: string,
  frame: number,
  at: Point,
): Promise<boolean> {
  const res = await mcp.callTool('get_pixels', {
    sprite_path: spritePath,
    layer_name: layerName,
    frame_number: frame,
    x: at.x,
    y: at.y,
    width: 1,
    height: 1,
  })
  if (!res.ok) return false

  const parsed = safeParse(res.text) as { pixels?: { color?: unknown }[] }
  const color = parsed?.pixels?.[0]?.color
  if (typeof color !== 'string') return true
  // Colours read back as #RRGGBBAA; a missing alpha pair means opaque.
  return color.length >= 9 && color.slice(7, 9).toUpperCase() === '00'
}

function paint(
  mcp: PixelMcp,
  spritePath: string,
  layerName: string,
  frame: number,
  at: Point,
  color: string,
): Promise<{ ok: boolean; text: string }> {
  return mcp.callTool('draw_rectangle', {
    sprite_path: spritePath,
    layer_name: layerName,
    frame_number: frame,
    x: at.x,
    y: at.y,
    width: 1,
    height: 1,
    color,
    filled: true,
  })
}

async function spriteSize(
  mcp: PixelMcp,
  spritePath: string,
): Promise<{ width: number; height: number } | null> {
  // Not cached: `resize_canvas` and `crop_sprite` are both in the core toolset, so a remembered
  // size would pin the wrong corner on the very calls that matter most.
  const res = await mcp.callTool('get_sprite_info', { sprite_path: spritePath })
  if (!res.ok) return null

  const parsed = safeParse(res.text) as { width?: unknown; height?: unknown }
  const width = Math.trunc(Number(parsed?.width))
  const height = Math.trunc(Number(parsed?.height))
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return null
  return { width, height }
}

function withBoundsNote(
  result: unknown,
  dropped: number,
  first: Point | null,
  size: { width: number; height: number } | null,
): unknown {
  if (dropped === 0 || !result || typeof result !== 'object') return result

  const bounds = size ? ` The canvas is ${size.width}x${size.height}` : ''
  const example = first ? `, e.g. (${first.x},${first.y})` : ''
  return {
    ...(result as Record<string, unknown>),
    skipped_off_canvas: dropped,
    note:
      `${dropped} pixel${dropped === 1 ? '' : 's'} fell outside the canvas and ${dropped === 1 ? 'was' : 'were'} not drawn${example}.` +
      `${bounds}, so valid coordinates run from (0,0) to (${(size?.width ?? 0) - 1},${(size?.height ?? 0) - 1}).`,
  }
}

function forward(mcp: PixelMcp, args: Record<string, unknown>) {
  return mcp.callTool('draw_pixels', args).then((res) => ({
    ok: res.ok,
    result: res.ok ? safeParse(res.text) : { error: res.text },
  }))
}

function pointOf(raw: unknown): Point | null {
  if (!raw || typeof raw !== 'object') return null
  const { x, y } = raw as { x?: unknown; y?: unknown }
  const px = Math.trunc(Number(x))
  const py = Math.trunc(Number(y))
  if (!Number.isFinite(px) || !Number.isFinite(py)) return null
  return { x: px, y: py }
}

function frameNumber(raw: unknown): number {
  const n = Math.trunc(Number(raw))
  return Number.isFinite(n) && n >= 1 ? n : 1
}

const key = (p: Point) => `${p.x},${p.y}`

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return { output: text }
  }
}
