import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from '../config.js'
import type { PixelMcp } from './client.js'

export interface PreviewResult {
  ok: boolean
  /** What goes back as the tool result the model reads. */
  result: unknown
  /** Present on success: the rendered image, to be injected as a user message and shown in the UI. */
  image?: {
    dataUri: string
    fileName: string
    sourceWidth: number
    sourceHeight: number
    scale: number
    spritePath: string
    note?: string
  }
}

/**
 * The verify loop.
 *
 * Scales a *copy* — `scale_sprite` mutates in place and would otherwise destroy the master — then
 * exports a PNG and hands it back as an image. Small sprites are unreadable at 1x, so this is the
 * difference between a model that can judge its own work and one that is drawing blind.
 */
export async function renderPreview(
  mcp: PixelMcp,
  args: Record<string, unknown>,
  runDir: string,
  seq: number,
): Promise<PreviewResult> {
  const spritePath = String(args.sprite_path ?? '')
  if (!spritePath) {
    return { ok: false, result: { error: 'sprite_path is required' } }
  }

  const frameNumber = Number.isFinite(Number(args.frame_number)) ? Math.trunc(Number(args.frame_number)) : 1
  const note = typeof args.note === 'string' ? args.note : undefined

  const info = await mcp.callTool('get_sprite_info', { sprite_path: spritePath })
  if (!info.ok) return { ok: false, result: { error: info.text } }

  const { width, height } = parseDimensions(info.text)
  if (!width || !height) {
    return { ok: false, result: { error: `could not read sprite dimensions: ${info.text}` } }
  }

  const scale = Math.min(
    config.previewMaxScale,
    Math.max(1, Math.round(config.previewTargetPx / Math.max(width, height))),
  )

  const tmpSprite = path.join(runDir, 'tmp', `preview-${seq}.aseprite`)
  const outPng = path.join(runDir, 'exports', `preview-${seq}.png`)
  await fs.mkdir(path.dirname(tmpSprite), { recursive: true })
  await fs.mkdir(path.dirname(outPng), { recursive: true })

  const copied = await mcp.callTool('save_as', { sprite_path: spritePath, output_path: tmpSprite })
  if (!copied.ok) return { ok: false, result: { error: copied.text } }

  if (scale > 1) {
    const scaled = await mcp.callTool('scale_sprite', {
      sprite_path: tmpSprite,
      scale_x: scale,
      scale_y: scale,
      algorithm: 'nearest',
    })
    if (!scaled.ok) return { ok: false, result: { error: scaled.text } }
  }

  const exported = await mcp.callTool('export_sprite', {
    sprite_path: tmpSprite,
    output_path: outPng,
    format: 'png',
    frame_number: frameNumber,
  })
  if (!exported.ok) return { ok: false, result: { error: exported.text } }

  let png: Buffer
  try {
    png = await fs.readFile(outPng)
  } catch (err) {
    return { ok: false, result: { error: `preview PNG was not written: ${String(err)}` } }
  }

  await fs.rm(tmpSprite, { force: true })

  return {
    ok: true,
    result: {
      ok: true,
      source_size: `${width}x${height}`,
      rendered_size: `${width * scale}x${height * scale}`,
      scale,
      image: 'The rendered image follows in the next message. Look at it and judge it.',
    },
    image: {
      dataUri: `data:image/png;base64,${png.toString('base64')}`,
      fileName: path.basename(outPng),
      sourceWidth: width,
      sourceHeight: height,
      scale,
      spritePath,
      note,
    },
  }
}

/** get_sprite_info answers with JSON, but be forgiving about the exact key names. */
function parseDimensions(text: string): { width: number; height: number } {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    const width = Number(parsed.width ?? parsed.Width)
    const height = Number(parsed.height ?? parsed.Height)
    if (Number.isFinite(width) && Number.isFinite(height)) return { width, height }
  } catch {
    // Fall through.
  }
  const m = text.match(/(\d+)\s*[x×]\s*(\d+)/)
  if (m) return { width: Number(m[1]), height: Number(m[2]) }
  return { width: 0, height: 0 }
}
