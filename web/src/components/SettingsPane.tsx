import { useEffect, useRef, useState } from 'react'
import type { Settings } from '../lib/settings'

interface Props {
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
}

/**
 * The cog, and the panel it opens.
 *
 * A popover rather than a modal: these are preferences you flip while looking at a run, not a place
 * you go and come back from.
 */
export function SettingsPane({ settings, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div ref={root} className="relative ml-auto">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Settings"
        aria-expanded={open}
        className={`flex items-center p-2 ${open ? 'text-coral' : 'text-muted hover:text-body'}`}
      >
        <CogIcon />
      </button>

      {open && (
        <div className="panel absolute right-0 top-full z-20 mt-1 w-[320px] space-y-4 p-4 shadow-lg shadow-ink/60">
          <p className="eyebrow">Settings</p>

          <label className="flex cursor-pointer items-start gap-2.5">
            <input
              type="checkbox"
              checked={settings.autoSaveFinal}
              onChange={(e) => onChange({ autoSaveFinal: e.target.checked })}
              className="h-3.5 w-3.5 shrink-0 accent-coral p-0"
            />
            <span className="space-y-1">
              <span className="block font-mono text-xs text-bright">
                Automatically save runs to gallery
              </span>
            </span>
          </label>
        </div>
      )}
    </div>
  )
}

function CogIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}
