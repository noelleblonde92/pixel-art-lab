export function formatCost(cost: number): string {
  if (!cost) return '$0.00'
  if (cost < 0.01) return `$${cost.toFixed(4)}`
  return `$${cost.toFixed(2)}`
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

export function formatContext(n: number): string {
  if (!n) return 'unknown'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  return `${Math.round(n / 1000)}k`
}

/** Per-million-token price, which is how model pricing is normally quoted. */
export function formatPrice(perToken: number): string {
  const perMillion = perToken * 1_000_000
  if (!perMillion) return 'free'
  if (perMillion < 1) return `$${perMillion.toFixed(2)}`
  return `$${perMillion.toFixed(2)}`
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

/** Whole-run wall clock, which runs to minutes — `formatDuration` is for single tool calls. */
export function formatElapsed(ms: number): string {
  if (!ms) return '—'
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
}

export function formatDate(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** Compact one-line rendering of tool arguments for the collapsed transcript row. */
export function summarizeArgs(args: unknown): string {
  if (args === null || args === undefined) return ''
  if (typeof args === 'string') return truncate(args, 80)
  if (typeof args !== 'object') return String(args)

  const entries = Object.entries(args as Record<string, unknown>)
  const parts = entries.map(([key, value]) => {
    if (Array.isArray(value)) return `${key}=[${value.length}]`
    if (value && typeof value === 'object') return `${key}={…}`
    if (typeof value === 'string') return `${key}=${truncate(value, 28)}`
    return `${key}=${String(value)}`
  })

  return truncate(parts.join(' '), 120)
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/** Sprite paths are the one argument worth surfacing by basename alone. */
export function basename(p: string): string {
  return p.split('/').pop() ?? p
}
