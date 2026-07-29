/**
 * Reader preferences, kept in the browser.
 *
 * These describe how the app behaves, not what any run did, so they stay out of the run record and
 * out of the server: nothing here changes a measurement or needs to travel between machines.
 */
export interface Settings {
  /** Keep a finished run's final image without being asked. */
  autoSaveFinal: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  // A run's workspace is pruned, so a result nobody clicked Save on is a run that was paid for and
  // then lost. Keeping it by default costs a few KB; the other way round costs the benchmark.
  autoSaveFinal: true,
}

const STORAGE_KEY = 'pixel-lab.settings'

/**
 * Layer stored JSON over the defaults, field by field.
 *
 * Anything missing, mistyped or left over from an older shape falls back to its default rather than
 * poisoning the whole object — a stored file outlives the code that wrote it.
 */
export function parseSettings(raw: string | null): Settings {
  if (!raw) return { ...DEFAULT_SETTINGS }
  let stored: unknown
  try {
    stored = JSON.parse(raw)
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
  if (!stored || typeof stored !== 'object') return { ...DEFAULT_SETTINGS }
  const fields = stored as Partial<Record<keyof Settings, unknown>>
  return {
    autoSaveFinal:
      typeof fields.autoSaveFinal === 'boolean'
        ? fields.autoSaveFinal
        : DEFAULT_SETTINGS.autoSaveFinal,
  }
}

export function loadSettings(): Settings {
  try {
    return parseSettings(localStorage.getItem(STORAGE_KEY))
  } catch {
    // Storage can be unavailable (private mode, a blocked origin); defaults are still usable.
    return { ...DEFAULT_SETTINGS }
  }
}

export function storeSettings(settings: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // A browser refusing to store just means the choice lasts one session.
  }
}
