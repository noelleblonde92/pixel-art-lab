import { useMemo, useState } from 'react'
import type { GalleryEntry, RunRequest } from '../types'
import { galleryImageUrl, gallerySpriteUrl } from '../lib/api'
import { entryTitle, groupByPrompt, shortModel } from '../lib/gallery'
import { formatCost, formatDate } from '../lib/format'
import { Compare } from './Compare'

interface Props {
  entries: GalleryEntry[]
  onPrefill: (request: RunRequest) => void
  onDelete: (id: string) => Promise<void>
  onLabel: (id: string, label: string) => Promise<void>
}

/**
 * Saved work, grouped by the prompt that produced it.
 *
 * The prompt is the benchmark, so the grouping is not a filing convenience — it is what turns a pile
 * of sprites into "here is what six models did with the same sentence". Anything else the reader
 * might want to line up is available by selecting entries by hand.
 */
export function Gallery({ entries, onPrefill, onDelete, onLabel }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [comparing, setComparing] = useState(false)

  const prompts = useMemo(() => groupByPrompt(entries), [entries])
  const byId = useMemo(() => new Map(entries.map((e) => [e.id, e])), [entries])
  const chosen = [...selected].map((id) => byId.get(id)).filter((e): e is GalleryEntry => !!e)

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })

  const compareAll = (group: GalleryEntry[]) => {
    setSelected(new Set(group.map((e) => e.id)))
    setComparing(true)
  }

  if (entries.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-10 text-center">
        <div className="max-w-sm space-y-2">
          <p className="eyebrow">Gallery is empty</p>
          <p className="font-mono text-xs leading-relaxed text-muted">
            Finish a run and save its image. Run the same prompt on another model and the two land in
            the same group, ready to compare.
          </p>
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-edge bg-panel px-5 py-2.5">
        <span className="eyebrow">
          {entries.length} saved · {prompts.length} prompt{prompts.length === 1 ? '' : 's'}
        </span>
        <span className="ml-auto flex items-center gap-2">
          {selected.size > 0 && (
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="font-mono text-[11px] text-muted hover:text-body"
            >
              clear {selected.size}
            </button>
          )}
          <button
            type="button"
            onClick={() => setComparing(true)}
            disabled={selected.size < 2}
            className="border border-edge px-3 py-1.5 font-mono text-[11px] text-body hover:border-coral hover:text-coral disabled:cursor-not-allowed disabled:opacity-40"
          >
            Compare {selected.size >= 2 ? selected.size : ''}
          </button>
        </span>
      </div>

      <div className="flex-1 space-y-8 overflow-y-auto p-5">
        {prompts.map((group) => (
          <section key={group.key} className="space-y-3">
            <header className="flex flex-wrap items-start justify-between gap-3 border-b border-edge pb-2">
              <div className="min-w-0 flex-1">
                <p className="font-sans text-sm leading-relaxed text-bright">{group.prompt}</p>
                <p className="eyebrow mt-1">
                  {group.entries.length} attempt{group.entries.length === 1 ? '' : 's'} ·{' '}
                  {group.models} model{group.models === 1 ? '' : 's'}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  type="button"
                  onClick={() => onPrefill(group.entries[group.entries.length - 1].request)}
                  title="Load this prompt into the form so another model can answer it"
                  className="border border-edge px-2.5 py-1 font-mono text-[11px] text-body hover:border-coral hover:text-coral"
                >
                  Run again
                </button>
                <button
                  type="button"
                  onClick={() => compareAll(group.entries)}
                  disabled={group.entries.length < 2}
                  className="border border-edge px-2.5 py-1 font-mono text-[11px] text-body hover:border-coral hover:text-coral disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Compare all
                </button>
              </div>
            </header>

            <ul className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3">
              {group.entries.map((entry) => (
                <EntryCard
                  key={entry.id}
                  entry={entry}
                  selected={selected.has(entry.id)}
                  onToggle={() => toggle(entry.id)}
                  onDelete={() => onDelete(entry.id)}
                  onLabel={(label) => onLabel(entry.id, label)}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>

      {comparing && chosen.length > 0 && (
        <Compare entries={chosen} onClose={() => setComparing(false)} />
      )}
    </>
  )
}

interface CardProps {
  entry: GalleryEntry
  selected: boolean
  onToggle: () => void
  onDelete: () => Promise<void>
  onLabel: (label: string) => Promise<void>
}

function EntryCard({ entry, selected, onToggle, onDelete, onLabel }: CardProps) {
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(entry.label ?? '')

  const commit = () => {
    setRenaming(false)
    if (draft.trim() !== (entry.label ?? '')) void onLabel(draft.trim())
  }

  return (
    <li
      className={`flex flex-col border bg-panel transition-colors ${
        selected ? 'border-coral' : 'border-edge hover:border-muted'
      }`}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={selected}
        title={`${entry.request.model} — click to select for comparison`}
        className="flex h-40 shrink-0 items-center justify-center bg-ink p-3"
      >
        {/* Blown up to fill the card, never smoothed — a 32×32 sprite shown at 32px is unreadable. */}
        <img
          src={galleryImageUrl(entry.id)}
          alt={entryTitle(entry)}
          className="pixelated h-full w-full object-contain"
        />
      </button>

      <div className="space-y-1 border-t border-edge p-2.5">
        {renaming ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit()
              if (e.key === 'Escape') setRenaming(false)
            }}
            placeholder={shortModel(entry.request.model)}
            className="w-full px-1 py-0.5 text-[11px]"
          />
        ) : (
          <p className="truncate font-mono text-xs text-bright" title={entry.request.model}>
            {entryTitle(entry)}
          </p>
        )}

        <p className="font-mono text-[10px] text-muted">
          {entry.width}×{entry.height} · {formatCost(entry.stats.cost)} ·{' '}
          {entry.stats.turns} turns · {entry.stats.iterations} it
        </p>
        <p className="font-mono text-[10px] text-muted/70">{formatDate(entry.savedAt)}</p>

        <div className="flex flex-wrap items-center gap-x-2 pt-1 font-mono text-[10px] text-muted">
          <button type="button" onClick={() => setRenaming(true)} className="hover:text-body">
            rename
          </button>
          <a href={galleryImageUrl(entry.id)} download className="hover:text-body">
            png
          </a>
          {entry.hasSprite && (
            <a href={gallerySpriteUrl(entry.id)} download className="hover:text-body">
              aseprite
            </a>
          )}
          <button
            type="button"
            onClick={() => void onDelete()}
            className="ml-auto hover:text-coral"
          >
            delete
          </button>
        </div>
      </div>
    </li>
  )
}
