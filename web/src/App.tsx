import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GalleryEntry, ModelInfo, RunEvent, RunRequest } from './types'
import { buildTimeline } from './lib/events'
import {
  cancelRun,
  deleteGalleryEntry,
  fetchGallery,
  fetchModels,
  labelGalleryEntry,
  saveToGallery,
  startRun,
  subscribeToRun,
  type SaveToGallery,
} from './lib/api'
import { runFileFromUrl } from './lib/gallery'
import { loadSettings, storeSettings, type Settings } from './lib/settings'
import { RunForm } from './components/RunForm'
import { SettingsPane } from './components/SettingsPane'
import { PreviewStrip } from './components/PreviewStrip'
import { Transcript } from './components/Transcript'
import { StatusBar } from './components/StatusBar'
import { ResultPanel } from './components/ResultPanel'
import { Gallery } from './components/Gallery'

type View = 'run' | 'gallery'

export default function App() {
  const [models, setModels] = useState<ModelInfo[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [runId, setRunId] = useState<string | undefined>()
  const [events, setEvents] = useState<RunEvent[]>([])
  const [selectedPreview, setSelectedPreview] = useState(0)
  /** Set only when the user has clicked a thumbnail, so live runs keep advancing on their own. */
  const [pinnedPreview, setPinnedPreview] = useState(false)
  const [view, setView] = useState<View>('run')
  const [entries, setEntries] = useState<GalleryEntry[]>([])
  /** A brief pulled back out of the gallery, waiting to be loaded into the form. */
  const [prefill, setPrefill] = useState<RunRequest | undefined>()
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const unsubscribe = useRef<(() => void) | null>(null)
  /** Runs auto-save has already answered for, so one attempt is one attempt. */
  const autoSaved = useRef(new Set<string>())

  useEffect(() => {
    fetchModels()
      .then(setModels)
      .catch((err: unknown) => setLoadError(String(err instanceof Error ? err.message : err)))
    fetchGallery()
      .then(setEntries)
      .catch(() => {
        // An unreadable gallery must not stop a run from being started.
      })
  }, [])

  useEffect(() => () => unsubscribe.current?.(), [])

  const timeline = useMemo(() => buildTimeline(events), [events])
  const running = timeline.status === 'running'

  // Follow the newest preview unless the reader has picked one to look at.
  useEffect(() => {
    if (!pinnedPreview && timeline.previews.length > 0) {
      setSelectedPreview(timeline.previews.length - 1)
    }
  }, [timeline.previews.length, pinnedPreview])

  /** Which of this run's files are already kept, so the same image is never saved twice. */
  const savedFiles = useMemo(
    () => new Set(entries.filter((e) => e.runId === runId).map((e) => e.sourceFile)),
    [entries, runId],
  )

  const clearPrefill = useCallback(() => setPrefill(undefined), [])

  const save = useCallback(async (request: SaveToGallery) => {
    const entry = await saveToGallery(request)
    setEntries((prev) => [entry, ...prev])
  }, [])

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch }
      storeSettings(next)
      return next
    })
  }, [])

  /**
   * Keep a finished run without being asked.
   *
   * Only the final image, and only once per run: the attempt is recorded before it is made, so a
   * save that fails surfaces its error instead of being retried on every render. A run that ended
   * with no PNG (a fatal error before anything was drawn) has nothing to keep.
   */
  useEffect(() => {
    if (!settings.autoSaveFinal || !runId) return
    const { status, finalPng, finalSprite } = timeline
    if (status !== 'finished' || !finalPng) return

    const key = `${runId}:${finalPng}`
    if (autoSaved.current.has(key) || savedFiles.has(finalPng)) return
    autoSaved.current.add(key)

    save({ runId, file: finalPng, spriteFile: finalSprite }).catch((err: unknown) =>
      setLoadError(
        `Could not save to the gallery: ${String(err instanceof Error ? err.message : err)}`,
      ),
    )
  }, [settings.autoSaveFinal, runId, timeline, savedFiles, save])

  const handleStart = async (request: RunRequest, references: File[]) => {
    unsubscribe.current?.()
    setEvents([])
    setSelectedPreview(0)
    setPinnedPreview(false)
    setLoadError(null)
    setView('run')

    try {
      const id = await startRun(request, references)
      setRunId(id)
      unsubscribe.current = subscribeToRun(
        id,
        (event) => setEvents((prev) => [...prev, event]),
        (message) => setLoadError(message),
      )
    } catch (err) {
      setLoadError(String(err instanceof Error ? err.message : err))
    }
  }

  const handleCancel = () => {
    if (runId) void cancelRun(runId)
  }

  const selectPreview = (index: number) => {
    setSelectedPreview(index)
    setPinnedPreview(true)
  }

  const savePreview = async (index: number) => {
    const preview = timeline.previews[index]
    const file = preview && runFileFromUrl(preview.url)
    if (!runId || !file) return
    await save({
      runId,
      file,
      spriteFile: preview.spritePath,
      sourceWidth: preview.width,
      sourceHeight: preview.height,
    })
  }

  const saveFinal = async () => {
    if (!runId || !timeline.finalPng) return
    await save({
      runId,
      file: timeline.finalPng,
      spriteFile: timeline.finalSprite,
    })
  }

  const deleteEntry = async (id: string) => {
    await deleteGalleryEntry(id)
    setEntries((prev) => prev.filter((e) => e.id !== id))
  }

  const labelEntry = async (id: string, label: string) => {
    const updated = await labelGalleryEntry(id, label)
    setEntries((prev) => prev.map((e) => (e.id === id ? updated : e)))
  }

  return (
    <div className="flex h-screen bg-ink">
      <aside className="flex w-[360px] shrink-0 flex-col border-r border-edge bg-panel">
        <RunForm
          models={models}
          busy={running}
          prefill={prefill}
          onPrefillUsed={clearPrefill}
          onStart={handleStart}
          onCancel={handleCancel}
        />
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <nav className="flex shrink-0 items-center gap-1 border-b border-edge bg-panel px-5">
          <Tab active={view === 'run'} onClick={() => setView('run')}>
            Run
          </Tab>
          <Tab active={view === 'gallery'} onClick={() => setView('gallery')}>
            Gallery{entries.length > 0 && ` (${entries.length})`}
          </Tab>
          <SettingsPane settings={settings} onChange={updateSettings} />
        </nav>

        {loadError && (
          <div className="border-b border-coral bg-coral/10 px-5 py-2 font-mono text-xs text-coral">
            {loadError}
          </div>
        )}

        {view === 'gallery' ? (
          <Gallery
            entries={entries}
            onPrefill={(request) => {
              setPrefill(request)
              setView('run')
            }}
            onDelete={deleteEntry}
            onLabel={labelEntry}
          />
        ) : (
          <>
            {timeline.previews.length > 0 && (
              <PreviewStrip
                previews={timeline.previews}
                selected={Math.min(selectedPreview, timeline.previews.length - 1)}
                onSelect={selectPreview}
                savedFiles={savedFiles}
                onSave={savePreview}
              />
            )}

            <Transcript
              entries={timeline.entries}
              running={running}
              onSelectPreview={selectPreview}
            />

            {runId && (
              <ResultPanel
                timeline={timeline}
                runId={runId}
                saved={!!timeline.finalPng && savedFiles.has(timeline.finalPng)}
                onSave={saveFinal}
              />
            )}
          </>
        )}

        <StatusBar timeline={timeline} runId={runId} />
      </main>
    </div>
  )
}

function Tab({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active}
      className={`-mb-px border-b-2 px-3 py-2 font-mono text-[11px] uppercase tracking-[0.14em] ${
        active
          ? 'border-coral text-bright'
          : 'border-transparent text-muted hover:text-body'
      }`}
    >
      {children}
    </button>
  )
}
