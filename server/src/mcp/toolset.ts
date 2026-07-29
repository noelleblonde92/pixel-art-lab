import type { McpToolDef } from './client.js'
import type { ToolsetName } from '../types.js'

/** An OpenAI-style function tool, which is what chat/completions wants. */
export interface FunctionTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

/**
 * Tools left out of the default "core" set.
 *
 * 50 schemas is a prompt-token tax paid on every single turn, and weaker models measurably
 * degrade with large tool menus — which would confound exactly the comparison this app exists to
 * make. These are the ones a drawing run rarely needs: the stateful selection/clipboard family,
 * destructive operations, and analysis tools whose output the model mostly ignores.
 */
const NON_CORE = new Set([
  'select_rectangle',
  'select_ellipse',
  'select_all',
  'deselect',
  'move_selection',
  'cut_selection',
  'copy_selection',
  'paste_clipboard',
  'analyze_palette_harmonies',
  'sort_palette',
  'link_cel',
  'suggest_antialiasing',
  'downsample_image',
  'export_spritesheet',
  'delete_tag',
  'delete_layer',
  'delete_frame',
  'flatten_layers',
])

/**
 * Hidden in every mode: `new_sprite` supersedes it.
 *
 * `create_canvas` has no path parameter and always writes to pixel-mcp's temp dir, which then needs
 * a `save_as` to rescue. Exposing that dance to every model under test would measure their ability
 * to read a warning, not their ability to draw.
 */
const ALWAYS_HIDDEN = new Set(['create_canvas'])

export const NEW_SPRITE_TOOL: FunctionTool = {
  type: 'function',
  function: {
    name: 'new_sprite',
    description:
      'Create a new sprite and save it into the workspace in one step. Returns the path to use for ' +
      'every later call. This is the only way to make a canvas.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description:
            'Short kebab-case subject name, no extension and no directory — e.g. "knight". ' +
            'The file lands at sprites/<name>.aseprite.',
        },
        width: { type: 'integer', description: 'Canvas width in pixels.' },
        height: { type: 'integer', description: 'Canvas height in pixels.' },
        color_mode: {
          type: 'string',
          enum: ['rgb', 'grayscale', 'indexed'],
          description: 'Colour mode. Use "rgb" unless you have a specific reason not to.',
        },
      },
      required: ['name', 'width', 'height'],
    },
  },
}

export const RENDER_PREVIEW_TOOL: FunctionTool = {
  type: 'function',
  function: {
    name: 'render_preview',
    description:
      'Render the sprite and LOOK at it. Returns a scaled-up PNG of the current state as an image ' +
      'so you can judge silhouette, colour values, contrast and placement. Call this after every ' +
      'round of edits — you cannot judge pixel art without seeing it.',
    parameters: {
      type: 'object',
      properties: {
        sprite_path: {
          type: 'string',
          description: 'Path to the sprite, e.g. sprites/knight.aseprite',
        },
        frame_number: {
          type: 'integer',
          description: '1-based frame to render. Use 0 to render all frames. Defaults to 1.',
        },
        note: {
          type: 'string',
          description: 'One short line naming what you are checking for in this render.',
        },
      },
      required: ['sprite_path'],
    },
  },
}

export const UNDO_TOOL: FunctionTool = {
  type: 'function',
  function: {
    name: 'undo',
    description:
      'Throw away every edit made since your last preview and put the sprite back to exactly the ' +
      'state you saw in that image. Use this the moment a round of edits has made the piece worse — ' +
      'reverting is far cheaper than painting over a mistake, and painting over rarely gets the ' +
      'original pixels back. Pass `iteration` to go further back, to any earlier preview.',
    parameters: {
      type: 'object',
      properties: {
        sprite_path: {
          type: 'string',
          description: 'Path to the sprite, e.g. sprites/knight.aseprite',
        },
        iteration: {
          type: 'integer',
          description:
            'Preview iteration to restore, as numbered in each preview message ("iteration N"). ' +
            'Omit to undo back to the most recent preview.',
        },
      },
      required: ['sprite_path'],
    },
  },
}

export const SYNTHETIC_TOOL_NAMES = new Set(['new_sprite', 'render_preview', 'undo'])

/**
 * MCP hands us JSON Schema and chat/completions takes JSON Schema, so this is a straight lift.
 *
 * `hasVision` is what keeps `render_preview` out of a blind model's menu. It has to be withheld here
 * rather than handled downstream: the tool's whole job is to inject an image as a user message, and
 * a text-only model sent an `image_url` part gets a 400 from the provider that kills the run. A
 * result explaining the refusal would not help either — a model that cannot see has nothing to do
 * with a preview, and the system prompt points it at `get_pixels` instead.
 *
 * `undo` goes with it, because previews are what it restores: a model with no preview tool never
 * takes a checkpoint, so the tool could only ever answer "nothing to undo". Leaving it in the menu
 * would cost that model schema tokens for a guaranteed dead end.
 */
export function buildToolset(
  mcpTools: McpToolDef[],
  toolset: ToolsetName,
  hasVision: boolean,
): FunctionTool[] {
  const forwarded = mcpTools
    .filter((t) => !ALWAYS_HIDDEN.has(t.name))
    .filter((t) => toolset === 'full' || !NON_CORE.has(t.name))
    .map<FunctionTool>((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: normalizeSchema(t.inputSchema),
      },
    }))

  const synthetic = hasVision
    ? [NEW_SPRITE_TOOL, RENDER_PREVIEW_TOOL, UNDO_TOOL]
    : [NEW_SPRITE_TOOL]
  return [...synthetic, ...forwarded]
}

/**
 * Providers vary in how strict they are about function schemas. Drop the dialect metadata some of
 * them reject and guarantee the object shape they all expect.
 *
 * `additionalProperties: false` is deliberately kept — pixel-mcp emits it, it is what OpenAI strict
 * mode wants, and it stops models inventing parameters that the Go structs will reject anyway.
 */
function normalizeSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const clean = stripKeys(schema, ['$schema', '$id'])
  if (typeof clean === 'object' && clean !== null && !Array.isArray(clean)) {
    const obj = clean as Record<string, unknown>
    if (!obj.type) obj.type = 'object'
    if (!obj.properties) obj.properties = {}
    return obj
  }
  return { type: 'object', properties: {} }
}

function stripKeys(value: unknown, keys: string[]): unknown {
  if (Array.isArray(value)) return value.map((v) => stripKeys(v, keys))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      if (keys.includes(k)) continue
      out[k] = stripKeys(v, keys)
    }
    return out
  }
  return value
}

/**
 * Models sometimes emit a tool name with the wrong case, a namespace prefix, or dashes for
 * underscores. Recover the intended tool rather than failing the call.
 */
export function matchToolName(requested: string, known: Iterable<string>): string | null {
  const names = [...known]
  if (names.includes(requested)) return requested

  const canon = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  const target = canon(requested.includes('.') ? requested.split('.').pop()! : requested)

  return names.find((n) => canon(n) === target) ?? null
}
