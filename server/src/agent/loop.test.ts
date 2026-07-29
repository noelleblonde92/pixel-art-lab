import { describe, expect, it } from 'vitest'
import { isEmptyResponse, resolveLimits } from './loop.js'
import { config } from '../config.js'

const request = (over: Record<string, unknown> = {}) => ({
  prompt: 'A knight',
  model: 'anthropic/claude',
  ...over,
})

describe('resolveLimits', () => {
  it('falls back to the default turn budget and no other cap', () => {
    expect(resolveLimits(request())).toEqual({
      maxTurns: config.defaultMaxTurns,
      maxIterations: undefined,
      maxCostUsd: undefined,
    })
  })

  it('takes the form values when they are within the ceilings', () => {
    expect(resolveLimits(request({ maxTurns: 12, maxIterations: 5, maxCostUsd: 0.25 }))).toEqual({
      maxTurns: 12,
      maxIterations: 5,
      maxCostUsd: 0.25,
    })
  })

  it('clamps each budget to its ceiling', () => {
    const limits = resolveLimits(
      request({ maxTurns: 10_000, maxIterations: 10_000, maxCostUsd: 10_000 }),
    )

    expect(limits.maxTurns).toBe(config.turnCeiling)
    expect(limits.maxIterations).toBe(config.iterationCeiling)
    expect(limits.maxCostUsd).toBe(config.costCeilingUsd)
  })

  // A zero or negative budget would stop the run before it drew anything, which is never what
  // someone typing into the form meant — read it as "no cap", the same as leaving it blank.
  it('ignores non-positive budgets', () => {
    expect(resolveLimits(request({ maxTurns: 0, maxIterations: 0, maxCostUsd: -1 }))).toEqual({
      maxTurns: config.defaultMaxTurns,
      maxIterations: undefined,
      maxCostUsd: undefined,
    })
  })
})

const turn = (over: Partial<{ text: string; reasoning: string; toolCalls: unknown[] }> = {}) => ({
  text: '',
  reasoning: '',
  toolCalls: [],
  ...over,
}) as Parameters<typeof isEmptyResponse>[0]

describe('isEmptyResponse', () => {
  // Run e32b48be ended on one of these and was recorded as a clean finish on a blank canvas.
  it('flags a turn that carries nothing at all', () => {
    expect(isEmptyResponse(turn())).toBe(true)
    expect(isEmptyResponse(turn({ text: '   \n ' }))).toBe(true)
  })

  it('leaves a genuine sign-off alone', () => {
    expect(isEmptyResponse(turn({ text: 'The knight is finished.' }))).toBe(false)
  })

  // Reasoning without prose still means the model spoke, so the turn is a real one.
  it('leaves a reasoning-only turn alone', () => {
    expect(isEmptyResponse(turn({ reasoning: 'Considering the silhouette...' }))).toBe(false)
  })

  it('leaves a turn that called tools alone', () => {
    expect(isEmptyResponse(turn({ toolCalls: [{ id: 'a' }] }))).toBe(false)
  })
})
