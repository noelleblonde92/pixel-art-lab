import { useState } from 'react'

interface Props {
  saved: boolean
  onSave: () => Promise<void>
  label?: string
  className?: string
}

/**
 * Keep this image.
 *
 * A run's workspace is disposable, so this is the one moment where an image either becomes a
 * benchmark record or is eventually pruned away — worth its own affordance next to the artwork
 * rather than a menu somewhere else.
 */
export function SaveButton({ saved, onSave, label = 'Save to gallery', className = '' }: Props) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const click = async () => {
    setBusy(true)
    setError(null)
    try {
      await onSave()
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err))
    } finally {
      setBusy(false)
    }
  }

  if (saved) {
    return (
      <span
        className={`border border-teal/40 px-3 py-1.5 font-mono text-[11px] text-teal ${className}`}
      >
        ✓ in gallery
      </span>
    )
  }

  return (
    <button
      type="button"
      onClick={() => void click()}
      disabled={busy}
      title={error ?? undefined}
      className={`border px-3 py-1.5 font-mono text-[11px] disabled:opacity-50 ${
        error
          ? 'border-coral text-coral'
          : 'border-edge text-body hover:border-teal hover:text-teal'
      } ${className}`}
    >
      {busy ? 'saving…' : error ? 'save failed' : label}
    </button>
  )
}
