/** Mirrors server/src/types.ts. */

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

export type ToolsetName = 'core' | 'full'

export interface RunRequest {
  prompt: string
  model: string
  width?: number
  height?: number
  aspectRatio?: string
  /** One turn is one model round-trip, however many tool calls it contains. */
  maxTurns?: number
  /** One iteration is one `render_preview`. Blank means no iteration cap. */
  maxIterations?: number
  /** Dollars. Blank means no cost cap. */
  maxCostUsd?: number
  reasoningEffort?: ReasoningEffort
  toolset?: ToolsetName
}

export type RunEndReason =
  | 'done'
  | 'max_turns'
  | 'max_iterations'
  | 'max_cost'
  | 'max_tool_calls'
  | 'empty_response'
  | 'cancelled'
  | 'error'

export type RunEvent =
  | {
      t: 'run.start'
      runId: string
      model: string
      maxTurns: number
      /** Absent when the run has no cap of that kind. */
      maxIterations?: number
      maxCostUsd?: number
      toolCount: number
    }
  | { t: 'turn.start'; n: number }
  | { t: 'text.delta'; text: string }
  | { t: 'reasoning.delta'; text: string }
  | { t: 'tool.call'; id: string; name: string; args: unknown }
  | { t: 'tool.result'; id: string; name: string; ok: boolean; result: unknown; ms: number }
  | {
      t: 'preview'
      id: string
      url: string
      spritePath: string
      width: number
      height: number
      scale: number
      note?: string
    }
  | {
      t: 'undo'
      id: string
      spritePath: string
      /**
       * The iteration the sprite was restored to. Every later preview *of this sprite* pictures a
       * canvas that no longer exists, which is what lets the UI mark those frames and the server
       * drop them from context. Iterations are numbered globally, so the sprite path is the scope.
       */
      restoredTo: number
    }
  | {
      t: 'usage'
      promptTokens: number
      completionTokens: number
      reasoningTokens: number
      /** Subset of promptTokens served from cache, and tokens written to it. */
      cachedTokens: number
      cacheWriteTokens: number
      cost: number
      cumulativeCost: number
    }
  | { t: 'warning'; message: string }
  | {
      t: 'run.end'
      reason: RunEndReason
      turns: number
      /** Preview cycles, not turns — see `RunRequest.maxIterations`. */
      iterations: number
      toolCalls: number
      cost: number
      finalSprite?: string
      finalPng?: string
      message?: string
    }

/** What a run cost and how much work it took — the numbers a benchmark is actually comparing. */
export interface RunStats {
  /** Model round-trips. */
  turns: number
  /** Preview cycles — how many times the model looked at its own work. */
  iterations: number
  toolCalls: number
  cost: number
  promptTokens: number
  completionTokens: number
  reasoningTokens: number
  /** Counted within promptTokens — a share, not an addition. */
  cachedTokens: number
  durationMs: number
  endReason?: RunEndReason
}

/** One saved image, kept with everything needed to compare it against another model's attempt. */
export interface GalleryEntry {
  id: string
  savedAt: number
  label?: string
  runId: string
  request: RunRequest
  sourceFile: string
  /** The sprite's own size in pixels — 32×32 art stays 32×32 here however it was rendered. */
  width: number
  height: number
  /** How much the saved PNG enlarges that art. 1 for a final export, N for a preview render. */
  scale: number
  hasSprite: boolean
  stats: RunStats
}

export interface ModelInfo {
  id: string
  name: string
  contextLength: number
  supportsTools: boolean
  supportsVision: boolean
  supportsEffort: boolean
  supportsReasoning: boolean
  /** The provider discounts cached input at all. */
  supportsCaching: boolean
  /** …but only caches at explicit breakpoints, rather than automatically. */
  needsCacheBreakpoints: boolean
  isModerated: boolean
  promptPrice: number
  completionPrice: number
  cacheReadPrice: number
  cacheWritePrice: number
  created: number
}
