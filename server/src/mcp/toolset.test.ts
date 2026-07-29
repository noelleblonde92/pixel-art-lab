import { describe, expect, it } from 'vitest'
import { buildToolset, matchToolName } from './toolset.js'
import type { McpToolDef } from './client.js'

const tool = (name: string): McpToolDef => ({
  name,
  description: `does ${name}`,
  inputSchema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: { sprite_path: { type: 'string' } },
    required: ['sprite_path'],
    additionalProperties: false,
  },
})

const mcpTools = [
  tool('create_canvas'),
  tool('draw_pixels'),
  tool('draw_line'),
  tool('select_rectangle'),
  tool('copy_selection'),
  tool('sort_palette'),
  tool('export_sprite'),
]

describe('buildToolset', () => {
  it('always puts the synthetic tools first', () => {
    const tools = buildToolset(mcpTools, 'core', true)
    expect(tools[0].function.name).toBe('new_sprite')
    expect(tools[1].function.name).toBe('render_preview')
  })

  it('hides create_canvas in every mode, since new_sprite supersedes it', () => {
    for (const mode of ['core', 'full'] as const) {
      const names = buildToolset(mcpTools, mode, true).map((t) => t.function.name)
      expect(names).not.toContain('create_canvas')
    }
  })

  // render_preview injects an image as a user message; a text-only model sent one 400s and the run
  // dies. Withholding the tool is what keeps that unreachable.
  it('withholds render_preview from a model without vision, in every mode', () => {
    for (const mode of ['core', 'full'] as const) {
      const names = buildToolset(mcpTools, mode, false).map((t) => t.function.name)
      expect(names).not.toContain('render_preview')
      expect(names[0]).toBe('new_sprite')
    }
  })

  it('leaves the rest of the menu alone when vision is absent', () => {
    const withVision = buildToolset(mcpTools, 'core', true).map((t) => t.function.name)
    const without = buildToolset(mcpTools, 'core', false).map((t) => t.function.name)
    expect(without).toEqual(withVision.filter((n) => n !== 'render_preview'))
  })

  it('drops the selection family from the core set but keeps it in full', () => {
    const core = buildToolset(mcpTools, 'core', true).map((t) => t.function.name)
    expect(core).not.toContain('select_rectangle')
    expect(core).not.toContain('copy_selection')
    expect(core).not.toContain('sort_palette')
    expect(core).toContain('draw_pixels')
    expect(core).toContain('export_sprite')

    const full = buildToolset(mcpTools, 'full', true).map((t) => t.function.name)
    expect(full).toContain('select_rectangle')
    expect(full).toContain('sort_palette')
  })

  it('strips dialect metadata but keeps additionalProperties', () => {
    const drawLine = buildToolset(mcpTools, 'core', true).find((t) => t.function.name === 'draw_line')!
    expect(drawLine.function.parameters).not.toHaveProperty('$schema')
    expect(drawLine.function.parameters).toHaveProperty('additionalProperties', false)
    expect(drawLine.function.parameters).toMatchObject({ type: 'object', required: ['sprite_path'] })
  })

  it('gives a schemaless tool a usable empty object schema', () => {
    const tools = buildToolset([{ name: 'odd', description: '', inputSchema: {} }], 'core', true)
    const odd = tools.find((t) => t.function.name === 'odd')!
    expect(odd.function.parameters).toEqual({ type: 'object', properties: {} })
  })
})

describe('matchToolName', () => {
  const known = ['draw_pixels', 'render_preview', 'apply_auto_shading']

  it('passes exact names straight through', () => {
    expect(matchToolName('draw_pixels', known)).toBe('draw_pixels')
  })

  it('recovers from casing, dashes, and namespace prefixes', () => {
    expect(matchToolName('DrawPixels', known)).toBe('draw_pixels')
    expect(matchToolName('draw-pixels', known)).toBe('draw_pixels')
    expect(matchToolName('pixel-mcp.draw_pixels', known)).toBe('draw_pixels')
    expect(matchToolName('APPLY_AUTO_SHADING', known)).toBe('apply_auto_shading')
  })

  it('returns null for a tool that does not exist', () => {
    expect(matchToolName('summon_dragon', known)).toBeNull()
  })
})
