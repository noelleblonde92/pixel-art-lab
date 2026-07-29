import { describe, expect, it } from 'vitest'
import { budgetStatus, isEmptyResponse, resolveLimits } from './loop.js'
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

describe('budgetStatus', () => {
  const spent = { turns: 7, iterations: 3, cost: 0.0123 }

  it('reports every budget the run actually has', () => {
    expect(budgetStatus(spent, { maxTurns: 20, maxIterations: 8, maxCostUsd: 0.05 })).toBe(
      'Turn 7 of 20 (13 left). Preview iteration 3 of 8 (5 left). Spent $0.0123 of the $0.0500 limit.',
    )
  })

  // The opt-in budgets are left unmentioned rather than reported as unlimited: naming a cap the run
  // does not have is what `budgetDirective` avoids in the prompt, for the same reason.
  it('names only the turn budget when the others were left blank', () => {
    expect(budgetStatus(spent, { maxTurns: 20 })).toBe('Turn 7 of 20 (13 left).')
  })

  it('reports the last turn and the last preview as zero left', () => {
    expect(budgetStatus({ turns: 20, iterations: 8, cost: 0 }, { maxTurns: 20, maxIterations: 8 })).toBe(
      'Turn 20 of 20 (0 left). Preview iteration 8 of 8 (0 left).',
    )
  })

  // A run can end past its cost limit — the check is between turns — and "-1 left" would read as a
  // budget the model could still spend against.
  it('never reports a negative remainder', () => {
    expect(budgetStatus({ turns: 3, iterations: 9, cost: 0 }, { maxTurns: 20, maxIterations: 8 })).toContain(
      'Preview iteration 9 of 8 (0 left).',
    )
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
