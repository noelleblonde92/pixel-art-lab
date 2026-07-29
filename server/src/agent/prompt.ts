import type { RunRequest } from '../types.js'
import type { RunLimits } from './loop.js'

export interface PromptContext {
  request: RunRequest
  limits: RunLimits
  referenceFiles: string[]
  hasVision: boolean
}

/**
 * The system prompt.
 *
 * Everything mechanical in here is a quirk that has actually bitten someone. If a model has to
 * rediscover the create_canvas temp-path dance on its own, this app ends up measuring
 * instruction-recovery rather than drawing ability, which defeats the point.
 *
 * A quirk the server can absorb outright beats one documented here, because documentation only
 * helps a model that follows it correctly — the cel-offset trap used to live in this file, and the
 * models that failed it were the ones that followed the instructions most literally. It is now
 * handled in mcp/drawPixels.ts and this prompt simply states the behaviour the model will observe.
 */
export function buildSystemPrompt(ctx: PromptContext): string {
  const { request: req, limits, referenceFiles, hasVision } = ctx

  const sections: string[] = []

  sections.push(
    `You are a pixel artist. You draw by calling tools against a real Aseprite install through an MCP server.
Your job is to produce one finished, readable piece of pixel art and then stop.`,
  )

  sections.push(`# The prompt

${req.prompt.trim()}`)

  sections.push(`# Canvas

${canvasDirective(req)}`)

  if (referenceFiles.length) {
    sections.push(`# Reference

${referenceFiles.length === 1 ? 'A reference image is' : 'Reference images are'} attached to the first message${hasVision ? ' — look at it directly' : ''}, and also on disk at:
${referenceFiles.map((f) => `  ${f}`).join('\n')}

Call \`analyze_reference\` on those paths to get an extracted palette, a brightness map, and an edge
map scaled to your target size. That is the fastest way to block in a likeness.`)
  }

  sections.push(`# How to work

Work in this order. Do not jump straight to detail.

1. **Palette first.** Pick a limited palette (8-16 colours) and \`set_palette\` it before drawing.
   Pass \`use_palette: true\` on drawing calls to snap to the nearest palette colour. Constraint is
   what makes pixel art read as pixel art.
2. **Silhouette before detail.** Block in the major shapes as flat colour and check the silhouette
   reads. A piece that is unreadable as a solid shape will not be rescued by interior detail.
3. **Shade with one light direction.** Shadows shift cool, highlights shift warm — hue-shift rather
   than just darkening. \`apply_auto_shading\` does this correctly by default; leave \`hue_shift\` on.
   Prefer \`cell\` style at small sizes. Never pillow-shade (darkening uniformly inward from every
   edge) — it reads flat.
4. **Detail and outline last.** \`apply_outline\` after the interior is settled.
5. Dither only across gradients wider than about 32px. Below that it turns to noise.`)

  sections.push(
    hasVision
      ? `# The verify loop — this is the important part

After every round of edits, call \`render_preview\` and actually look at the image it returns.
Judge it honestly: is the silhouette readable? Do the values separate, or are two colours too close
to tell apart? Is anything off by a pixel or on the wrong layer? Then fix what is wrong and preview
again. Do not declare the piece finished until you have looked at it and are satisfied.`
      : `# Verifying your work — this is the important part

You cannot see images, so there is no preview step in your toolset. \`get_pixels\` is your only way
to check what actually landed: after every round of edits, read back the region you just drew and
confirm the colours are where you meant them. Be exact with coordinates — nothing is going to show
you a mistake, so an off-by-one stays wrong until you read it back.`,
  )

  sections.push(`# Tools and rules that will bite you

- **\`new_sprite\` is how you create a canvas.** It returns the \`sprite_path\` to use for every later
  call. A fresh canvas has exactly one layer named \`Layer 1\` — not "Background".
- **\`layer_name\` is required on every drawing call.** There is no current-layer default.
- Run \`get_sprite_info\` if you are ever unsure of layer names, frame count, or dimensions.
- **Frames and layers are 1-based.** The one exception: \`export_sprite\` takes \`frame_number: 0\`
  to mean *all frames*, which is what you want for GIFs.
- **Coordinates are top-left origin, +y points down.** (0,0) is the top-left pixel.
- **Colours are hex strings**, \`#RRGGBB\` or \`#RRGGBBAA\`. Not names, not integers.
- A filled rectangle of \`#00000000\` works as an eraser.
- **Every drawing tool takes plain canvas coordinates**, \`draw_pixels\` included, on any layer and
  whether or not anything has been drawn there yet. \`get_pixels\` reads back in the same
  coordinates, so you can use it to confirm placement. A pixel outside the canvas is not drawn and
  is reported back to you in the tool result — nothing is dropped silently.`)

  sections.push(`# Budget

${budgetDirective(limits, hasVision)}

When the piece is finished, reply with a short plain-text summary and no tool calls. That is how you
signal you are done.`)

  return sections.join('\n\n')
}

/**
 * The run's hard limits, in the model's own units.
 *
 * Only the turn budget always exists; the other two are stated only when they are real, because a
 * model told about a limit it cannot hit will pace itself against a fiction. The iteration cap is
 * one of those for a blind model: it counts previews, and a model without `render_preview` can
 * never reach it.
 */
function budgetDirective(limits: RunLimits, hasVision: boolean): string {
  const lines = [
    `You have about ${limits.maxTurns} turns. Spend roughly the first half blocking in shapes and ` +
      `colour, and the second half refining against ${hasVision ? 'previews' : '`get_pixels` readbacks'}. ` +
      `Do not spend your whole budget on a palette.`,
  ]

  // The counts above are the only ones a blind model gets; a model with previews is told where the
  // live ones are, because a stated total it cannot check is what it would otherwise pace against.
  if (hasVision) {
    lines.push(
      `Every \`render_preview\` result carries a \`budget\` line with what is actually left. Read ` +
        `it and pace against it — it is current, and these opening numbers are not.`,
    )
  }

  if (hasVision && limits.maxIterations !== undefined) {
    lines.push(
      `You may call \`render_preview\` at most ${limits.maxIterations} times — the run ends there, ` +
        `finished or not. Make each look count: fix everything you can see wrong before previewing ` +
        `again, rather than previewing after every small edit.`,
    )
  }

  if (limits.maxCostUsd !== undefined) {
    lines.push(
      `The run also stops once it has spent $${limits.maxCostUsd.toFixed(2)}, so keep your ` +
        `messages and tool arguments tight.`,
    )
  }

  return lines.join('\n\n')
}

function canvasDirective(req: RunRequest): string {
  const lines: string[] = []

  if (req.width && req.height) {
    lines.push(`Use a canvas of exactly ${req.width}x${req.height} pixels.`)
  } else if (req.width) {
    lines.push(`Use a canvas ${req.width} pixels wide; choose a sensible height.`)
  } else if (req.height) {
    lines.push(`Use a canvas ${req.height} pixels tall; choose a sensible width.`)
  } else if (req.aspectRatio) {
    lines.push(
      `Choose a canvas size suited to the subject at an aspect ratio of ${req.aspectRatio}. ` +
        `16-64px on the long edge is typical for a single subject.`,
    )
  } else {
    lines.push(
      'Choose a canvas size suited to the subject. 16-64px is typical for a single character or ' +
        'object; go larger only if the subject genuinely needs the room.',
    )
  }

  if (req.aspectRatio && (req.width || req.height)) {
    lines.push(`Target aspect ratio: ${req.aspectRatio}.`)
  }

  lines.push(
    'Work at the real pixel size — do not draw large and downscale. Every pixel should be placed ' +
      'deliberately.',
  )

  return lines.join(' ')
}
