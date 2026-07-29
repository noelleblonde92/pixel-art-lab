import { useState } from 'react'
import { formatDuration, summarizeArgs } from '../lib/format'

interface Props {
  name: string
  args: unknown
  ok?: boolean
  result?: unknown
  ms?: number
}

export function ToolCallItem({ name, args, ok, result, ms }: Props) {
  const [open, setOpen] = useState(false)
  const pending = ok === undefined
  const failed = ok === false

  return (
    <div className={`border-l-2 pl-3 ${failed ? 'border-coral' : 'border-edge'}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="group flex w-full items-baseline gap-2 text-left"
      >
        <span className={`font-mono text-xs ${failed ? 'text-coral' : 'text-teal'}`}>{name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted group-hover:text-body">
          {summarizeArgs(args)}
        </span>
        {pending ? (
          <span className="shrink-0 font-mono text-[10px] text-amber">running</span>
        ) : (
          <span className="shrink-0 font-mono text-[10px] text-muted">
            {ms !== undefined ? formatDuration(ms) : ''}
          </span>
        )}
      </button>

      {open && (
        <div className="mt-1.5 space-y-1.5">
          <Block label="arguments" value={args} />
          {!pending && <Block label={failed ? 'error' : 'result'} value={result} tone={failed} />}
        </div>
      )}

      {failed && !open && <ErrorLine result={result} />}
    </div>
  )
}

/** A failure is worth showing without a click — it is usually why the run went sideways. */
function ErrorLine({ result }: { result: unknown }) {
  const message =
    result && typeof result === 'object' && 'error' in result
      ? String((result as { error: unknown }).error)
      : null
  if (!message) return null
  return (
    <p className="mt-1 font-mono text-[11px] leading-relaxed text-coral/90">{message}</p>
  )
}

function Block({ label, value, tone }: { label: string; value: unknown; tone?: boolean }) {
  return (
    <div>
      <p className="eyebrow mb-0.5">{label}</p>
      <pre
        className={`overflow-x-auto whitespace-pre-wrap break-all border border-edge bg-ink p-2 font-mono text-[11px] leading-relaxed ${
          tone ? 'text-coral/90' : 'text-body'
        }`}
      >
        {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  )
}
