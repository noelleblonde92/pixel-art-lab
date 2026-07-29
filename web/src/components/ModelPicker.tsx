import { useMemo, useState } from 'react'
import type { ModelInfo } from '../types'
import { filterModels } from '../lib/models'
import { formatContext, formatPrice } from '../lib/format'

interface Props {
  models: ModelInfo[]
  value: string
  onChange: (id: string) => void
  disabled: boolean
}

export function ModelPicker({ models, value, onChange, disabled }: Props) {
  const [search, setSearch] = useState('')
  const [visionOnly, setVisionOnly] = useState(true)
  const [open, setOpen] = useState(false)

  const matches = useMemo(
    () => filterModels(models, { search, visionOnly }),
    [models, search, visionOnly],
  )

  const selected = models.find((m) => m.id === value)

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between">
        <label className="eyebrow" htmlFor="model-search">
          Model
        </label>
        <label className="flex items-center gap-1.5 font-mono text-[10px] text-muted">
          <input
            type="checkbox"
            checked={visionOnly}
            onChange={(e) => setVisionOnly(e.target.checked)}
            className="h-3 w-3 accent-coral p-0"
          />
          can see previews
        </label>
      </div>

      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className="w-full border border-edge bg-ink px-2 py-2 text-left font-mono text-sm text-bright hover:border-muted disabled:opacity-50"
      >
        {selected ? (
          <span className="flex items-baseline justify-between gap-2">
            <span className="truncate">{selected.id}</span>
            <span className="shrink-0 text-[10px] text-muted">
              {formatContext(selected.contextLength)}
            </span>
          </span>
        ) : (
          <span className="text-muted">Choose a model…</span>
        )}
      </button>

      {selected && <Capabilities model={selected} />}

      {open && !disabled && (
        <div className="panel">
          <input
            id="model-search"
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={`Search ${matches.length} models…`}
            className="w-full border-0 border-b border-edge"
          />
          <ul className="max-h-72 overflow-y-auto">
            {matches.length === 0 && (
              <li className="px-2 py-3 font-mono text-xs text-muted">
                No models match. Clear the search or allow models that cannot see previews.
              </li>
            )}
            {matches.slice(0, 120).map((model) => (
              <li key={model.id}>
                <button
                  type="button"
                  onClick={() => {
                    onChange(model.id)
                    setOpen(false)
                    setSearch('')
                  }}
                  className={`flex w-full items-baseline justify-between gap-3 px-2 py-1.5 text-left font-mono text-xs hover:bg-raised ${
                    model.id === value ? 'bg-raised text-coral' : 'text-body'
                  }`}
                >
                  <span className="truncate">{model.id}</span>
                  <span className="flex shrink-0 items-center gap-2 text-[10px] text-muted">
                    {model.supportsVision && <span className="text-teal">vision</span>}
                    <span>{formatPrice(model.promptPrice)}/M</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function Capabilities({ model }: { model: ModelInfo }) {
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-1.5">
        <Tag tone={model.supportsVision ? 'good' : 'warn'}>
          {model.supportsVision ? 'sees previews' : 'cannot see previews'}
        </Tag>
        {model.supportsEffort && <Tag tone="neutral">reasoning effort</Tag>}
        {model.isModerated && <Tag tone="neutral">provider moderated</Tag>}
      </div>
      <p className="font-mono text-[10px] leading-relaxed text-muted">
        {formatPrice(model.promptPrice)}/M in · {formatPrice(model.completionPrice)}/M out ·{' '}
        {formatContext(model.contextLength)} context
      </p>
      {!model.supportsVision && (
        <p className="border-l-2 border-amber pl-2 font-mono text-[10px] leading-relaxed text-amber">
          This model is drawing blind. It can call render_preview but cannot see the result, so it has
          to work from get_pixels alone.
        </p>
      )}
    </div>
  )
}

function Tag({ children, tone }: { children: React.ReactNode; tone: 'good' | 'warn' | 'neutral' }) {
  const tones = {
    good: 'border-teal/40 text-teal',
    warn: 'border-amber/40 text-amber',
    neutral: 'border-edge text-muted',
  }
  return (
    <span className={`border px-1.5 py-0.5 font-mono text-[10px] ${tones[tone]}`}>{children}</span>
  )
}
