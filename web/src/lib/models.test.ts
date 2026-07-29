import { describe, expect, it } from 'vitest'
import { filterModels, groupByVendor, estimateRunCost } from './models'
import type { ModelInfo } from '../types'

const model = (overrides: Partial<ModelInfo> & { id: string }): ModelInfo => ({
  name: overrides.id,
  contextLength: 200_000,
  supportsTools: true,
  supportsVision: true,
  supportsEffort: true,
  supportsReasoning: true,
  supportsCaching: true,
  needsCacheBreakpoints: true,
  isModerated: false,
  promptPrice: 0.000003,
  completionPrice: 0.000015,
  cacheReadPrice: 0.0000003,
  cacheWritePrice: 0.00000375,
  created: 0,
  ...overrides,
})

const catalogue = [
  model({ id: 'anthropic/claude-opus-5', name: 'Claude Opus 5' }),
  model({ id: 'openai/gpt-5.2', name: 'GPT-5.2' }),
  model({ id: 'meta/llama-4-text', name: 'Llama 4 Text', supportsVision: false }),
  model({ id: 'legacy/no-tools', name: 'Legacy', supportsTools: false }),
]

describe('filterModels', () => {
  it('always excludes models without tool calling', () => {
    const ids = filterModels(catalogue, { search: '', visionOnly: false }).map((m) => m.id)
    expect(ids).not.toContain('legacy/no-tools')
    expect(ids).toHaveLength(3)
  })

  it('excludes blind models when vision is required', () => {
    const ids = filterModels(catalogue, { search: '', visionOnly: true }).map((m) => m.id)
    expect(ids).toEqual(['anthropic/claude-opus-5', 'openai/gpt-5.2'])
  })

  it('searches id and display name, case-insensitively', () => {
    expect(filterModels(catalogue, { search: 'OPUS', visionOnly: true })).toHaveLength(1)
    expect(filterModels(catalogue, { search: 'gpt', visionOnly: true })).toHaveLength(1)
    expect(filterModels(catalogue, { search: 'Llama 4', visionOnly: false })).toHaveLength(1)
  })

  it('ignores surrounding whitespace in the search', () => {
    expect(filterModels(catalogue, { search: '  opus  ', visionOnly: true })).toHaveLength(1)
  })

  it('returns nothing when the search matches nothing', () => {
    expect(filterModels(catalogue, { search: 'zzz', visionOnly: false })).toEqual([])
  })
})

describe('estimateRunCost', () => {
  it('grows with the turn count', () => {
    const m = catalogue[0]
    expect(estimateRunCost(m, 40)).toBeGreaterThan(estimateRunCost(m, 10))
  })

  it('is zero for a free model', () => {
    const free = model({ id: 'free/thing', promptPrice: 0, completionPrice: 0 })
    expect(estimateRunCost(free, 40)).toBe(0)
  })
})

describe('groupByVendor', () => {
  it('groups by the id prefix and sorts vendors alphabetically', () => {
    const groups = groupByVendor(catalogue)
    expect(groups.map(([vendor]) => vendor)).toEqual(['anthropic', 'legacy', 'meta', 'openai'])
    expect(groups[0][1]).toHaveLength(1)
  })
})
