import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, parseSettings } from './settings'

describe('parseSettings', () => {
  it('defaults to auto-saving when nothing is stored', () => {
    expect(parseSettings(null)).toEqual({ autoSaveFinal: true })
    expect(DEFAULT_SETTINGS.autoSaveFinal).toBe(true)
  })

  it('keeps a stored choice, including the non-default one', () => {
    expect(parseSettings('{"autoSaveFinal":false}')).toEqual({ autoSaveFinal: false })
    expect(parseSettings('{"autoSaveFinal":true}')).toEqual({ autoSaveFinal: true })
  })

  it('falls back to defaults for malformed or foreign values', () => {
    for (const raw of ['', 'not json', 'null', '42', '[]', '{}', '{"autoSaveFinal":"yes"}']) {
      expect(parseSettings(raw), raw).toEqual(DEFAULT_SETTINGS)
    }
  })

  it('ignores unknown fields rather than carrying them forward', () => {
    expect(parseSettings('{"autoSaveFinal":false,"gone":1}')).toEqual({ autoSaveFinal: false })
  })
})
