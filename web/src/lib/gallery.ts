import type { GalleryEntry } from '../types'

/**
 * The gallery, folded into benchmarks.
 *
 * The brief *is* the benchmark: two entries drawn from the same words are two models answering the
 * same question, and that is the only comparison worth putting side by side. Grouping is therefore
 * on the prompt text rather than on anything the user has to remember to set.
 */
export interface Brief {
  key: string
  /** The brief as first written — later entries with trivially different spacing join the group. */
  prompt: string
  entries: GalleryEntry[]
  /** How many distinct models have attempted it. */
  models: number
  /** Newest save in the group, which is what the list is ordered by. */
  savedAt: number
}

export function briefKey(prompt: string): string {
  return prompt.trim().toLowerCase().replace(/\s+/g, ' ')
}

export function groupByBrief(entries: GalleryEntry[]): Brief[] {
  const groups = new Map<string, Brief>()

  for (const entry of entries) {
    const key = briefKey(entry.request.prompt)
    const existing = groups.get(key)

    if (existing) {
      existing.entries.push(entry)
      existing.savedAt = Math.max(existing.savedAt, entry.savedAt)
    } else {
      groups.set(key, {
        key,
        prompt: entry.request.prompt.trim(),
        entries: [entry],
        models: 0,
        savedAt: entry.savedAt,
      })
    }
  }

  const briefs = [...groups.values()]
  for (const brief of briefs) {
    brief.entries.sort((a, b) => a.savedAt - b.savedAt)
    brief.models = new Set(brief.entries.map((e) => e.request.model)).size
  }

  return briefs.sort((a, b) => b.savedAt - a.savedAt)
}

/**
 * Which entries tie for the lowest value of a metric.
 *
 * Ties are kept rather than broken arbitrarily — two models that both spent $0.004 did equally
 * well, and picking one of them as "the winner" would be a lie about the measurement.
 */
export function leaders(entries: GalleryEntry[], metric: (e: GalleryEntry) => number): Set<string> {
  const usable = entries.filter((e) => Number.isFinite(metric(e)))
  if (usable.length < 2) return new Set()

  const best = Math.min(...usable.map(metric))
  return new Set(usable.filter((e) => metric(e) === best).map((e) => e.id))
}

/** A short name for an entry: its label, else the model's trailing segment. */
export function entryTitle(entry: GalleryEntry): string {
  return entry.label ?? shortModel(entry.request.model)
}

export function shortModel(model: string): string {
  return model.split('/').pop() ?? model
}

/** `/api/runs/<id>/files/exports/preview-3.png` → `exports/preview-3.png`, which is what saving takes. */
export function runFileFromUrl(url: string): string | undefined {
  const at = url.indexOf('/files/')
  return at === -1 ? undefined : url.slice(at + '/files/'.length)
}
