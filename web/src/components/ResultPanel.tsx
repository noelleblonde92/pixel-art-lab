import type { Timeline } from '../lib/events'
import { endReasonLabel } from '../lib/events'
import { basename } from '../lib/format'
import { SaveButton } from './SaveButton'

interface Props {
  timeline: Timeline
  runId: string
  saved: boolean
  onSave: () => Promise<void>
}

export function ResultPanel({ timeline, runId, saved, onSave }: Props) {
  const { endReason, endMessage, finalSprite, finalPng } = timeline
  if (!endReason) return null

  const failed = endReason === 'error'
  const accent = failed ? 'border-coral' : endReason === 'done' ? 'border-teal' : 'border-amber'

  return (
    <section className={`border-t-2 bg-panel px-5 py-4 ${accent}`}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1 space-y-2">
          <p className="eyebrow">{endReasonLabel(endReason)}</p>
          {endMessage && (
            <p
              className={`whitespace-pre-wrap font-sans text-sm leading-relaxed ${
                failed ? 'text-coral' : 'text-body'
              }`}
            >
              {endMessage}
            </p>
          )}
        </div>

        {(finalSprite || finalPng) && (
          <div className="flex shrink-0 gap-2">
            {finalPng && <SaveButton saved={saved} onSave={onSave} />}
            {finalPng && (
              <a
                href={`/api/runs/${runId}/files/${finalPng}`}
                download
                className="border border-edge px-3 py-1.5 font-mono text-[11px] text-body hover:border-coral hover:text-coral"
              >
                {basename(finalPng)}
              </a>
            )}
            {finalSprite && (
              <a
                href={`/api/runs/${runId}/files/${finalSprite}`}
                download
                className="border border-edge px-3 py-1.5 font-mono text-[11px] text-body hover:border-coral hover:text-coral"
              >
                {basename(finalSprite)}
              </a>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
