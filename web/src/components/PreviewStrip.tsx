import type { Preview } from '../lib/events'
import { runFileFromUrl } from '../lib/gallery'
import { SaveButton } from './SaveButton'

interface Props {
  previews: Preview[]
  selected: number
  onSelect: (index: number) => void
  /** Run-relative paths already in the gallery, so a kept preview says so. */
  savedFiles: Set<string>
  onSave: (index: number) => Promise<void>
}

/**
 * The run, as a filmstrip.
 *
 * Every render_preview appends a frame, so the whole evolution of the piece is visible at once and
 * any two iterations can be compared directly. That comparison is the thing this tool exists to
 * show, so it gets the top of the page and the only shadow in the interface.
 */
export function PreviewStrip({ previews, selected, onSelect, savedFiles, onSave }: Props) {
  const current = previews[selected]
  if (!current) return null

  const file = runFileFromUrl(current.url)

  return (
    <section className="border-b border-edge bg-panel">
      <div className="flex items-start gap-6 p-5">
        <figure className="shrink-0 space-y-2">
          <div className="border border-edge bg-ink p-3 shadow-lg shadow-black/40">
            <img
              src={current.url}
              alt={`Iteration ${selected + 1} of ${current.spritePath}`}
              className="pixelated block h-64 w-64 object-contain"
            />
          </div>
          {file && (
            <SaveButton
              saved={savedFiles.has(file)}
              onSave={() => onSave(selected)}
              label="Save this frame"
              className="block w-full text-center"
            />
          )}
        </figure>

        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <p className="eyebrow">
              Iteration {selected + 1} of {previews.length} · turn {current.turn}
            </p>
            <p className="mt-1 font-mono text-sm text-bright">{current.spritePath}</p>
            <p className="font-mono text-[11px] text-muted">
              {current.width}×{current.height} shown at {current.scale}×
            </p>
          </div>

          {current.note && (
            <p className="border-l-2 border-teal pl-3 font-mono text-xs leading-relaxed text-body">
              {current.note}
            </p>
          )}

          <div className="flex flex-wrap gap-1.5">
            {previews.map((preview, index) => (
              <button
                key={preview.id + index}
                type="button"
                onClick={() => onSelect(index)}
                title={`Iteration ${index + 1} · turn ${preview.turn}`}
                aria-current={index === selected}
                className={`border p-0.5 transition-colors ${
                  index === selected
                    ? 'border-coral'
                    : 'border-edge hover:border-muted'
                }`}
              >
                <img
                  src={preview.url}
                  alt=""
                  className="pixelated block h-10 w-10 object-contain bg-ink"
                />
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
