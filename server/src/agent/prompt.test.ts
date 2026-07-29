import { describe, expect, it } from 'vitest'
import { buildSystemPrompt } from './prompt.js'
import type { RunRequest } from '../types.js'

const request: RunRequest = { prompt: 'a knight', model: 'test/model' }

const build = (hasVision: boolean, over: Partial<Parameters<typeof buildSystemPrompt>[0]> = {}) =>
  buildSystemPrompt({
    request,
    limits: { maxTurns: 40 },
    referenceFiles: [],
    hasVision,
    ...over,
  })

describe('buildSystemPrompt', () => {
  it('sends a vision model into the preview loop', () => {
    const prompt = build(true)
    expect(prompt).toContain('render_preview')
    expect(prompt).toContain('# The verify loop')
  })

  // The tool is withheld from a blind model's menu, so naming it here would send the model chasing
  // something it does not have — and the image it returns is what 400s a text-only endpoint.
  it('never names render_preview to a model without vision', () => {
    expect(build(false)).not.toContain('render_preview')
  })

  it('points a blind model at get_pixels instead', () => {
    const prompt = build(false)
    expect(prompt).toContain('get_pixels')
    expect(prompt).toContain('cannot see images')
  })

  it('states an iteration cap only to a model that can reach it', () => {
    const limits = { maxTurns: 40, maxIterations: 6 }
    expect(build(true, { limits })).toContain('at most 6 times')
    expect(build(false, { limits })).not.toContain('at most 6 times')
  })

  // The prompt's own totals are a starting position, not a running count; the preview result is the
  // only place the model can read what is actually left, so a model with previews is sent there.
  it('points a vision model at the live budget on preview results', () => {
    expect(build(true)).toContain('`budget` line')
    expect(build(false)).not.toContain('`budget` line')
  })

  it('still states the cost cap to a blind model, which can reach it', () => {
    const limits = { maxTurns: 40, maxCostUsd: 0.5 }
    expect(build(false, { limits })).toContain('$0.50')
  })

  it('does not promise a blind model that a reference image is visible', () => {
    const referenceFiles = ['reference/knight.png']
    expect(build(true, { referenceFiles })).toContain('look at it directly')
    expect(build(false, { referenceFiles })).not.toContain('look at it directly')
    expect(build(false, { referenceFiles })).toContain('analyze_reference')
  })
})
