import { useEffect, useRef, useState } from 'react'
import type { Entry } from '../lib/events'
import { ToolCallItem } from './ToolCallItem'

interface Props {
  entries: Entry[]
  running: boolean
  onSelectPreview: (index: number) => void
}

export function Transcript({ entries, running, onSelectPreview }: Props) {
  const bottom = useRef<HTMLDivElement>(null)
  const [showReasoning, setShowReasoning] = useState(true)
  const [pinned, setPinned] = useState(true)

  useEffect(() => {
    if (pinned && running) bottom.current?.scrollIntoView({ block: 'end' })
  }, [entries.length, pinned, running])

  const visible = showReasoning ? entries : entries.filter((e) => e.kind !== 'reasoning')

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-edge px-5 py-2">
        <span className="eyebrow">Transcript</span>
        <div className="flex items-center gap-4">
          <Toggle checked={showReasoning} onChange={setShowReasoning} label="reasoning" />
          <Toggle checked={pinned} onChange={setPinned} label="follow" />
        </div>
      </div>

      <div
        className="min-h-0 flex-1 space-y-3 overflow-y-auto p-5"
        onWheel={(e) => {
          // Scrolling up mid-run means the reader wants to look at something; stop fighting them.
          if (e.deltaY < 0) setPinned(false)
        }}
      >
        {visible.length === 0 && (
          <p className="font-mono text-xs leading-relaxed text-muted">
            Nothing yet. Fill in a prompt on the left and start a run — the model's reasoning, every
            tool call, and each preview render will appear here as it happens.
          </p>
        )}

        {visible.map((entry) => (
          <EntryView key={entry.key} entry={entry} onSelectPreview={onSelectPreview} />
        ))}

        <div ref={bottom} />
      </div>
    </div>
  )
}

function EntryView({
  entry,
  onSelectPreview,
}: {
  entry: Entry
  onSelectPreview: (index: number) => void
}) {
  switch (entry.kind) {
    case 'turn':
      return (
        <div className="flex items-center gap-3 pt-2">
          <span className="eyebrow shrink-0">Turn {entry.n}</span>
          <span className="h-px flex-1 bg-edge" />
        </div>
      )

    case 'text':
      return (
        <p className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-bright">
          {entry.text}
        </p>
      )

    case 'reasoning':
      return (
        <p className="whitespace-pre-wrap border-l-2 border-raised pl-3 font-mono text-[11px] leading-relaxed text-muted">
          {entry.text}
        </p>
      )

    case 'tool':
      return (
        <ToolCallItem
          name={entry.name}
          args={entry.args}
          ok={entry.ok}
          result={entry.result}
          ms={entry.ms}
        />
      )

    case 'preview':
      return (
        <button
          type="button"
          onClick={() => onSelectPreview(entry.index)}
          className="flex items-center gap-3 border border-edge bg-panel p-2 text-left hover:border-coral"
        >
          <img
            src={entry.url}
            alt=""
            className={`pixelated h-16 w-16 shrink-0 bg-ink object-contain ${
              entry.undone ? 'opacity-40' : ''
            }`}
          />
          <span className="min-w-0">
            <span className="block font-mono text-xs text-coral">
              render_preview
              {entry.undone && <span className="text-amber"> · undone</span>}
            </span>
            <span className="block truncate font-mono text-[11px] text-muted">
              {entry.width}×{entry.height} at {entry.scale}×
              {entry.note ? ` — ${entry.note}` : ''}
            </span>
          </span>
        </button>
      )

    case 'warning':
      return (
        <p className="border-l-2 border-amber pl-3 font-mono text-[11px] leading-relaxed text-amber">
          {entry.message}
        </p>
      )
  }
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
}) {
  return (
    <label className="flex cursor-pointer items-center gap-1.5 font-mono text-[10px] text-muted">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3 w-3 accent-coral p-0"
      />
      {label}
    </label>
  )
}
