import type { ModelInfo } from '../types'

export interface ModelFilters {
  search: string
  visionOnly: boolean
}

/**
 * Tool calling is a hard requirement — a model without it cannot drive Aseprite at all, so those are
 * never offered. Vision is a soft filter: a blind model can still draw, and watching one try is a
 * legitimate experiment.
 */
export function filterModels(models: ModelInfo[], filters: ModelFilters): ModelInfo[] {
  const needle = filters.search.trim().toLowerCase()

  return models.filter((model) => {
    if (!model.supportsTools) return false
    if (filters.visionOnly && !model.supportsVision) return false
    if (!needle) return true
    return model.id.toLowerCase().includes(needle) || model.name.toLowerCase().includes(needle)
  })
}

/** Rough cost of a run that uses its whole turn budget, to make the tradeoff visible up front. */
export function estimateRunCost(model: ModelInfo, turns: number): number {
  // Context grows as history accumulates; midpoint of a linear ramp is a fair rough guess.
  const avgPromptTokens = 6000 + turns * 400
  const avgCompletionTokens = 700
  return turns * (avgPromptTokens * model.promptPrice + avgCompletionTokens * model.completionPrice)
}

export function groupByVendor(models: ModelInfo[]): Array<[string, ModelInfo[]]> {
  const groups = new Map<string, ModelInfo[]>()
  for (const model of models) {
    const vendor = model.id.split('/')[0] ?? 'other'
    const list = groups.get(vendor)
    if (list) list.push(model)
    else groups.set(vendor, [model])
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))
}
