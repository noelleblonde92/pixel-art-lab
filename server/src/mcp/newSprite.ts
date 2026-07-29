import path from 'node:path'
import type { PixelMcp } from './client.js'

/**
 * `create_canvas` + `save_as`, fused.
 *
 * pixel-mcp's create_canvas takes no path and always writes to its temp dir, which gets wiped without
 * warning. Left exposed, every model under test would have to read that warning and remember the
 * two-step dance — measuring instruction-following rather than drawing. So the temp path never
 * reaches the model: we do the save_as here and hand back the workspace path.
 */
export async function newSprite(
  mcp: PixelMcp,
  args: Record<string, unknown>,
  runDir: string,
): Promise<{ ok: boolean; result: unknown }> {
  const width = Math.trunc(Number(args.width))
  const height = Math.trunc(Number(args.height))
  const colorMode = typeof args.color_mode === 'string' ? args.color_mode : 'rgb'

  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    return { ok: false, result: { error: 'width and height must be positive integers' } }
  }
  if (width > 1024 || height > 1024) {
    return {
      ok: false,
      result: { error: 'width and height must each be 1024 or less — this is pixel art, keep it small' },
    }
  }

  const name = sanitizeName(args.name)
  const spritePath = path.join(runDir, 'sprites', `${name}.aseprite`)

  const created = await mcp.callTool('create_canvas', {
    width,
    height,
    color_mode: colorMode,
  })
  if (!created.ok) return { ok: false, result: { error: created.text } }

  const tempPath = extractFilePath(created.text)
  if (!tempPath) {
    return { ok: false, result: { error: `create_canvas returned no file_path: ${created.text}` } }
  }

  const saved = await mcp.callTool('save_as', {
    sprite_path: tempPath,
    output_path: spritePath,
  })
  if (!saved.ok) return { ok: false, result: { error: saved.text } }

  return {
    ok: true,
    result: {
      sprite_path: path.relative(runDir, spritePath),
      width,
      height,
      color_mode: colorMode,
      layer_name: 'Layer 1',
      note: 'Use this sprite_path for every later call. The single starting layer is named "Layer 1".',
    },
  }
}

function sanitizeName(raw: unknown): string {
  const base = typeof raw === 'string' ? raw : 'sprite'
  const cleaned = path
    .basename(base)
    .replace(/\.aseprite$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return cleaned || 'sprite'
}

function extractFilePath(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    const value = parsed.file_path ?? parsed.filePath ?? parsed.path
    if (typeof value === 'string') return value
  } catch {
    // Not JSON — fall through to the regex below.
  }
  return text.match(/[^\s"']+\.aseprite/)?.[0] ?? null
}
