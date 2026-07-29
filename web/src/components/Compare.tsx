import type { ReactNode } from 'react'
import type { GalleryEntry } from '../types'
import { galleryImageUrl } from '../lib/api'
import { briefKey, entryTitle, leaders } from '../lib/gallery'
import { endReasonLabel } from '../lib/events'
import { formatCost, formatElapsed, formatTokens } from '../lib/format'

interface Props {
  entries: GalleryEntry[]
  onClose: () => void
}

interface Row {
  label: string
  render: (entry: GalleryEntry) => ReactNode
  /** Lower is better; entries tying for the lowest are marked. */
  metric?: (entry: GalleryEntry) => number
}

const ROWS: Row[] = [
  // The caption above already carries the short name (or the entry's label); this is the full id.
  { label: 'model', render: (e) => e.request.model },
  { label: 'size', render: (e) => `${e.width}×${e.height}` },
  {
    label: 'cost',
    render: (e) => formatCost(e.stats.cost),
    metric: (e) => e.stats.cost,
  },
  {
    label: 'turns',
    render: (e) => e.stats.turns,
    metric: (e) => e.stats.turns,
  },
  {
    label: 'iterations',
    render: (e) => e.stats.iterations,
    metric: (e) => e.stats.iterations,
  },
  {
    label: 'tool calls',
    render: (e) => e.stats.toolCalls,
    metric: (e) => e.stats.toolCalls,
  },
  {
    label: 'wall clock',
    render: (e) => formatElapsed(e.stats.durationMs),
    metric: (e) => e.stats.durationMs,
  },
  {
    label: 'tokens',
    render: (e) =>
      `${formatTokens(e.stats.promptTokens)} in · ${formatTokens(e.stats.completionTokens)} out`,
  },
  {
    label: 'cached',
    render: (e) =>
      e.stats.promptTokens
        ? `${Math.round((e.stats.cachedTokens / e.stats.promptTokens) * 100)}%`
        : '—',
  },
  { label: 'effort', render: (e) => e.request.reasoningEffort ?? '—' },
  { label: 'tools', render: (e) => e.request.toolset ?? 'core' },
  { label: 'ended', render: (e) => (e.stats.endReason ? endReasonLabel(e.stats.endReason) : '—') },
]

/**
 * Several models' answers to the same brief, side by side.
 *
 * The images are the argument, so they get the room; the numbers underneath exist to answer "and
 * what did that cost?". Cheapest, fastest and fewest-steps are marked because those are the axes
 * where a worse-looking sprite can still be the better result.
 */
export function Compare({ entries, onClose }: Props) {
  if (entries.length === 0) return null

  const columns = `140px repeat(${entries.length}, minmax(190px, 1fr))`
  const best = new Map(
    ROWS.filter((row) => row.metric).map((row) => [row.label, leaders(entries, row.metric!)]),
  )

  // Selecting across groups is allowed, but then there is no single brief to put in the header —
  // and no honest like-for-like reading of the numbers below either.
  const key = briefKey(entries[0].request.prompt)
  const sameBrief = entries.every((e) => briefKey(e.request.prompt) === key)

  return (
    <div className="fixed inset-0 z-30 flex flex-col bg-ink/95 backdrop-blur-sm">
      <header className="flex items-start justify-between gap-6 border-b border-edge px-6 py-4">
        <div className="min-w-0">
          <p className="eyebrow">Comparing {entries.length} attempts</p>
          {sameBrief ? (
            <p className="mt-1 truncate font-sans text-sm text-bright">
              {entries[0].request.prompt}
            </p>
          ) : (
            <p className="mt-1 font-mono text-xs text-amber">
              Different briefs — the images answer different questions, so read the numbers with
              care.
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 border border-edge px-3 py-1.5 font-mono text-[11px] text-body hover:border-coral hover:text-coral"
        >
          Close
        </button>
      </header>

      <div className="flex-1 overflow-auto p-6">
        <div className="grid min-w-max gap-x-4" style={{ gridTemplateColumns: columns }}>
          <div />
          {entries.map((entry) => (
            <figure key={entry.id} className="space-y-2">
              <div className="flex aspect-square items-center justify-center border border-edge bg-panel p-3">
                <img
                  src={galleryImageUrl(entry.id)}
                  alt={entryTitle(entry)}
                  className="pixelated h-full w-full object-contain"
                />
              </div>
              <figcaption className="truncate font-mono text-xs text-bright" title={entry.request.model}>
                {entryTitle(entry)}
              </figcaption>
            </figure>
          ))}

          {ROWS.map((row) => {
            const winners = best.get(row.label)
            return (
              <div key={row.label} className="contents">
                <div className="border-t border-edge py-2 pr-2">
                  <span className="eyebrow">{row.label}</span>
                </div>
                {entries.map((entry) => (
                  <div
                    key={entry.id}
                    className={`border-t border-edge py-2 font-mono text-xs ${
                      winners?.has(entry.id) ? 'text-teal' : 'text-body'
                    }`}
                  >
                    {row.render(entry)}
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
