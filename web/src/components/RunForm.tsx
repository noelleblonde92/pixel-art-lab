import { useEffect, useRef, useState } from 'react'
import type { ModelInfo, ReasoningEffort, RunRequest, ToolsetName } from '../types'
import { ModelPicker } from './ModelPicker'
import { estimateRunCost } from '../lib/models'
import { formatCost } from '../lib/format'

interface Props {
  models: ModelInfo[]
  busy: boolean
  /** A brief recalled from the gallery, to be answered again. */
  prefill?: RunRequest
  onPrefillUsed: () => void
  onStart: (request: RunRequest, references: File[]) => void
  onCancel: () => void
}

const EFFORTS: ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']

/** Mirrors `config.defaultMaxTurns` — only used to price a blank field before the run starts. */
const DEFAULT_MAX_TURNS = 40

export function RunForm({ models, busy, prefill, onPrefillUsed, onStart, onCancel }: Props) {
  const [prompt, setPrompt] = useState('')
  const [model, setModel] = useState('')
  const [width, setWidth] = useState('')
  const [height, setHeight] = useState('')
  const [aspectRatio, setAspectRatio] = useState('')
  const [maxTurns, setMaxTurns] = useState('')
  const [maxIterations, setMaxIterations] = useState('')
  const [maxCost, setMaxCost] = useState('')
  const [effort, setEffort] = useState<ReasoningEffort>('medium')
  const [toolset, setToolset] = useState<ToolsetName>('core')
  const [references, setReferences] = useState<File[]>([])
  const fileInput = useRef<HTMLInputElement>(null)

  /**
   * Recall a brief from the gallery — everything except the model.
   *
   * The reason to run a saved brief again is to see what a *different* model makes of it, and the
   * canvas and budget have to carry over or the second result is not comparable. References are the
   * one thing that cannot come back: the browser has no file to re-attach.
   */
  useEffect(() => {
    if (!prefill) return
    setPrompt(prefill.prompt)
    setWidth(prefill.width ? String(prefill.width) : '')
    setHeight(prefill.height ? String(prefill.height) : '')
    setAspectRatio(prefill.aspectRatio ?? '')
    setMaxTurns(prefill.maxTurns ? String(prefill.maxTurns) : '')
    setMaxIterations(prefill.maxIterations ? String(prefill.maxIterations) : '')
    setMaxCost(prefill.maxCostUsd ? String(prefill.maxCostUsd) : '')
    if (prefill.reasoningEffort) setEffort(prefill.reasoningEffort)
    if (prefill.toolset) setToolset(prefill.toolset)
    onPrefillUsed()
  }, [prefill, onPrefillUsed])

  const selected = models.find((m) => m.id === model)
  const canStart = prompt.trim() !== '' && model !== '' && !busy

  const turnBudget = Number(maxTurns) || DEFAULT_MAX_TURNS
  // The estimate prices the turns; an iteration or cost cap can only end the run sooner, so this
  // stays an upper bound either way.
  const estimate = selected ? estimateRunCost(selected, turnBudget) : 0

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!canStart) return
    onStart(
      {
        prompt: prompt.trim(),
        model,
        width: width ? Number(width) : undefined,
        height: height ? Number(height) : undefined,
        aspectRatio: aspectRatio.trim() || undefined,
        maxTurns: maxTurns ? Number(maxTurns) : undefined,
        maxIterations: maxIterations ? Number(maxIterations) : undefined,
        maxCostUsd: maxCost ? Number(maxCost) : undefined,
        reasoningEffort: selected?.supportsEffort ? effort : undefined,
        toolset,
      },
      references,
    )
  }

  return (
    <form onSubmit={submit} className="flex h-full flex-col gap-5 overflow-y-auto p-5">
      <header>
        <h1 className="font-mono text-lg font-bold uppercase tracking-[0.14em] text-bright">
          Pixel<span className="text-coral">/</span>Lab
        </h1>
      </header>

      <div className="space-y-2">
        <label className="eyebrow" htmlFor="prompt">
          Brief
        </label>
        <textarea
          id="prompt"
          rows={4}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          disabled={busy}
          placeholder="A knight in dented steel armour, facing left, torch-lit from the right"
          className="w-full resize-y leading-relaxed"
        />
      </div>

      <ModelPicker models={models} value={model} onChange={setModel} disabled={busy} />

      <fieldset className="space-y-2" disabled={busy}>
        <legend className="eyebrow mb-2">Canvas</legend>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Width">
            <input
              type="number"
              min={1}
              value={width}
              onChange={(e) => setWidth(e.target.value)}
              placeholder="auto"
              className="w-full"
            />
          </Field>
          <Field label="Height">
            <input
              type="number"
              min={1}
              value={height}
              onChange={(e) => setHeight(e.target.value)}
              placeholder="auto"
              className="w-full"
            />
          </Field>
        </div>
        <Field label="Aspect ratio">
          <input
            value={aspectRatio}
            onChange={(e) => setAspectRatio(e.target.value)}
            placeholder="auto — e.g. 1:1, 3:4"
            className="w-full"
          />
        </Field>
        <p className="font-mono text-[10px] leading-relaxed text-muted/70">
          Empty input = model chooses values itself
        </p>
      </fieldset>

      <fieldset className="space-y-2" disabled={busy}>
        <legend className="eyebrow mb-2">Budget</legend>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Max turns">
            <input
              type="number"
              min={1}
              max={100}
              value={maxTurns}
              onChange={(e) => setMaxTurns(e.target.value)}
              placeholder={String(DEFAULT_MAX_TURNS)}
              className="w-full"
            />
          </Field>
          <Field label="Max iterations">
            <input
              type="number"
              min={1}
              max={50}
              value={maxIterations}
              onChange={(e) => setMaxIterations(e.target.value)}
              placeholder="none"
              className="w-full"
            />
          </Field>
        </div>
        <Field label="Max cost ($)">
          <input
            type="number"
            min={0}
            step={0.01}
            value={maxCost}
            onChange={(e) => setMaxCost(e.target.value)}
            placeholder="none"
            className="w-full"
          />
        </Field>
        <p className="font-mono text-[10px] leading-relaxed text-muted/70">
          <b>Turns</b> = number of API call.<br></br>
          <b>Iterations</b> = number of times the model looks at its own work and fixes it.
        </p>
        <Field label="Reasoning effort">
          <select
            value={effort}
            onChange={(e) => setEffort(e.target.value as ReasoningEffort)}
            disabled={busy || (selected ? !selected.supportsEffort : false)}
            className="w-full disabled:opacity-40"
            title={
              selected && !selected.supportsEffort
                ? 'This model does not accept a reasoning effort setting.'
                : undefined
            }
          >
            {EFFORTS.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Tools">
          <select
            value={toolset}
            onChange={(e) => setToolset(e.target.value as ToolsetName)}
            className="w-full"
          >
            <option value="core">core — the drawing set</option>
            <option value="full">full — every pixel-mcp tool</option>
          </select>
        </Field>
      </fieldset>

      <fieldset className="space-y-2" disabled={busy}>
        <legend className="eyebrow mb-2">Reference</legend>
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          multiple
          onChange={(e) => setReferences(Array.from(e.target.files ?? []))}
          className="hidden"
        />
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          className="w-full border border-dashed border-edge px-2 py-3 font-mono text-xs text-muted hover:border-muted hover:text-body"
        >
          {references.length === 0
            ? 'Attach reference images'
            : `${references.length} image${references.length === 1 ? '' : 's'} attached`}
        </button>
        {references.length > 0 && (
          <ul className="space-y-1">
            {references.map((file) => (
              <li key={file.name} className="truncate font-mono text-[10px] text-muted">
                {file.name}
              </li>
            ))}
          </ul>
        )}
      </fieldset>

      <div className="mt-auto space-y-2 pt-2">
        {selected && estimate > 0 && (
          <p className="font-mono text-[10px] text-muted">
            Rough cost at {turnBudget} turns: {formatCost(estimate)}
          </p>
        )}
        {busy ? (
          <button
            type="button"
            onClick={onCancel}
            className="w-full border border-coral bg-transparent px-3 py-2.5 font-mono text-sm uppercase tracking-[0.14em] text-coral hover:bg-coral hover:text-ink"
          >
            Stop run
          </button>
        ) : (
          <button
            type="submit"
            disabled={!canStart}
            className="w-full bg-coral px-3 py-2.5 font-mono text-sm uppercase tracking-[0.14em] text-ink hover:bg-amber disabled:cursor-not-allowed disabled:bg-edge disabled:text-muted"
          >
            Draw it
          </button>
        )}
      </div>
    </form>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="eyebrow block">{label}</span>
      {children}
    </label>
  )
}
