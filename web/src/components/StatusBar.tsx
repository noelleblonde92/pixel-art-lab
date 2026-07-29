import type { Timeline } from '../lib/events'
import { endReasonLabel } from '../lib/events'
import { formatCost, formatTokens } from '../lib/format'

interface Props {
  timeline: Timeline
  runId?: string
}

export function StatusBar({ timeline, runId }: Props) {
  const running = timeline.status === 'running'
  const reason = timeline.endReason

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-1 border-t border-edge bg-panel px-5 py-2">
      <Stat label="status">
        <span
          className={
            running
              ? 'text-amber'
              : reason === 'done'
                ? 'text-teal'
                : reason === 'error'
                  ? 'text-coral'
                  : 'text-muted'
          }
        >
          {running ? 'running' : reason ? endReasonLabel(reason).toLowerCase() : 'idle'}
        </span>
      </Stat>

      <Stat label="turn">
        {timeline.turn}
        {timeline.maxTurns ? `/${timeline.maxTurns}` : ''}
      </Stat>

      <Stat label="iteration">
        {timeline.previews.length}
        {timeline.maxIterations ? `/${timeline.maxIterations}` : ''}
      </Stat>

      <Stat label="tools">{timeline.toolCalls}</Stat>

      <Stat label="tokens">
        {formatTokens(timeline.promptTokens)} in · {formatTokens(timeline.completionTokens)} out
        {timeline.reasoningTokens > 0 && ` · ${formatTokens(timeline.reasoningTokens)} reasoning`}
      </Stat>

      {/* A share of input, not an extra cost — the point of showing it is to tell at a glance
          whether caching is working for this model, since it is worth ~10x on the input bill. */}
      {timeline.promptTokens > 0 && (
        <Stat label="cached">
          <span className={timeline.cachedTokens > 0 ? 'text-teal' : 'text-muted'}>
            {Math.round((timeline.cachedTokens / timeline.promptTokens) * 100)}%
          </span>
        </Stat>
      )}

      <Stat label="cost">
        <span className="text-bright">
          {formatCost(timeline.cost)}
          {timeline.maxCostUsd ? ` / ${formatCost(timeline.maxCostUsd)}` : ''}
        </span>
      </Stat>

      {timeline.model && <Stat label="model">{timeline.model}</Stat>}
      {runId && <Stat label="run">{runId}</Stat>}
    </div>
  )
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="eyebrow">{label}</span>
      <span className="font-mono text-[11px] text-body">{children}</span>
    </span>
  )
}
