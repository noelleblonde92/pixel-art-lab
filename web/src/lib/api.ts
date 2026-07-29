import type { GalleryEntry, ModelInfo, RunEvent, RunRequest } from '../types'

export async function fetchModels(): Promise<ModelInfo[]> {
  const res = await fetch('/api/models')
  if (!res.ok) throw new Error(`Could not load models: ${res.status}`)
  const body = (await res.json()) as { models: ModelInfo[] }
  return body.models
}

export async function startRun(request: RunRequest, references: File[]): Promise<string> {
  const form = new FormData()
  for (const [key, value] of Object.entries(request)) {
    if (value !== undefined && value !== '') form.append(key, String(value))
  }
  for (const file of references) form.append('reference', file)

  const res = await fetch('/api/runs', { method: 'POST', body: form })
  const body = (await res.json()) as { runId?: string; error?: string }
  if (!res.ok || !body.runId) throw new Error(body.error ?? `Could not start the run: ${res.status}`)
  return body.runId
}

export async function cancelRun(runId: string): Promise<void> {
  await fetch(`/api/runs/${runId}/cancel`, { method: 'POST' })
}

export interface DeleteRunsResult {
  removed: number
  /** Left alone because the run is still going. */
  skipped: number
}

/** Delete every run workspace. Saved gallery entries are copies and survive it. */
export async function deleteAllRuns(): Promise<DeleteRunsResult> {
  const res = await fetch('/api/runs', { method: 'DELETE' })
  const body = (await res.json()) as Partial<DeleteRunsResult> & { error?: string }
  if (!res.ok || typeof body.removed !== 'number' || typeof body.skipped !== 'number') {
    throw new Error(body.error ?? `Could not delete the runs: ${res.status}`)
  }
  return { removed: body.removed, skipped: body.skipped }
}

export interface SaveToGallery {
  runId: string
  /** Path inside the run workspace, e.g. `exports/final.png`. */
  file: string
  spriteFile?: string
  label?: string
  /** The sprite's own size, when it is known — a preview PNG is an enlargement of it. */
  sourceWidth?: number
  sourceHeight?: number
}

export async function fetchGallery(): Promise<GalleryEntry[]> {
  const res = await fetch('/api/gallery')
  if (!res.ok) throw new Error(`Could not load the gallery: ${res.status}`)
  const body = (await res.json()) as { entries: GalleryEntry[] }
  return body.entries
}

export async function saveToGallery(request: SaveToGallery): Promise<GalleryEntry> {
  const res = await fetch('/api/gallery', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  })
  const body = (await res.json()) as { entry?: GalleryEntry; error?: string }
  if (!res.ok || !body.entry) throw new Error(body.error ?? `Could not save: ${res.status}`)
  return body.entry
}

export async function labelGalleryEntry(id: string, label: string): Promise<GalleryEntry> {
  const res = await fetch(`/api/gallery/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label }),
  })
  const body = (await res.json()) as { entry?: GalleryEntry; error?: string }
  if (!res.ok || !body.entry) throw new Error(body.error ?? `Could not rename: ${res.status}`)
  return body.entry
}

export async function deleteGalleryEntry(id: string): Promise<void> {
  const res = await fetch(`/api/gallery/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`Could not delete: ${res.status}`)
}

export function galleryImageUrl(id: string): string {
  return `/api/gallery/${id}/image`
}

export function gallerySpriteUrl(id: string): string {
  return `/api/gallery/${id}/sprite`
}

/** Subscribe to a run's event stream. Returns an unsubscribe function. */
export function subscribeToRun(
  runId: string,
  onEvent: (event: RunEvent) => void,
  onError: (message: string) => void,
): () => void {
  const source = new EventSource(`/api/runs/${runId}/events`)
  let finished = false

  source.onmessage = (message) => {
    try {
      const event = JSON.parse(message.data) as RunEvent
      if (event.t === 'run.end') finished = true
      onEvent(event)
    } catch {
      // Ignore malformed frames rather than tearing down a live run.
    }
  }

  source.onerror = () => {
    // The server closes the stream once a run ends; that is not a failure.
    if (!finished) onError('Lost the connection to the run.')
    source.close()
  }

  return () => source.close()
}
