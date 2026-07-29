import { config } from '../config.js'
import type { ModelInfo } from '../types.js'

interface RawModel {
  id: string
  name: string
  created?: number
  context_length?: number
  architecture?: { input_modalities?: string[] }
  pricing?: {
    prompt?: string
    completion?: string
    input_cache_read?: string
    input_cache_write?: string
  }
  supported_parameters?: string[]
  top_provider?: { is_moderated?: boolean; context_length?: number }
}

let cache: { at: number; models: ModelInfo[] } | null = null
const CACHE_MS = 10 * 60 * 1000

/**
 * OpenRouter's catalogue, reduced to the capability flags this app actually decides on.
 *
 * Proxied rather than fetched from the browser so the API key never leaves the server.
 */
export async function listModels(force = false): Promise<ModelInfo[]> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.models

  const res = await fetch(`${config.openRouterBase}/models`, {
    headers: { Authorization: `Bearer ${config.openRouterKey}` },
  })
  if (!res.ok) {
    throw new Error(`OpenRouter /models failed: ${res.status} ${await res.text()}`)
  }

  const body = (await res.json()) as { data: RawModel[] }
  const models = body.data.map(toModelInfo).sort((a, b) => b.created - a.created)

  cache = { at: Date.now(), models }
  return models
}

export async function getModel(id: string): Promise<ModelInfo | undefined> {
  return (await listModels()).find((m) => m.id === id)
}

function toModelInfo(raw: RawModel): ModelInfo {
  const params = raw.supported_parameters ?? []
  const modalities = raw.architecture?.input_modalities ?? []
  const cacheReadPrice = Number(raw.pricing?.input_cache_read ?? 0)
  const cacheWritePrice = Number(raw.pricing?.input_cache_write ?? 0)

  return {
    id: raw.id,
    name: raw.name,
    contextLength: raw.context_length ?? raw.top_provider?.context_length ?? 0,
    // Without tool calling a model simply cannot drive Aseprite — this is the hard filter.
    supportsTools: params.includes('tools'),
    // Without vision it can still draw, but it is drawing blind: render_preview tells it nothing.
    supportsVision: modalities.includes('image'),
    supportsReasoning: params.includes('reasoning'),
    supportsEffort: params.includes('reasoning_effort') || params.includes('reasoning'),
    isModerated: raw.top_provider?.is_moderated === true,
    promptPrice: Number(raw.pricing?.prompt ?? 0),
    completionPrice: Number(raw.pricing?.completion ?? 0),
    cacheReadPrice,
    cacheWritePrice,
    supportsCaching: cacheReadPrice > 0,
    // A priced cache *write* is the tell that the provider caches only where you tell it to:
    // Anthropic, Alibaba and Google bill for the write, while OpenAI, DeepSeek, Groq and xAI cache
    // automatically and quote a read price alone. Only the former need breakpoints in the request.
    needsCacheBreakpoints: cacheWritePrice > 0,
    created: raw.created ?? 0,
  }
}
