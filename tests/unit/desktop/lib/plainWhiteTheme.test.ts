// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  hydrateHostTheme,
  readThemePreference,
  resolveThemePreference,
  writeThemePreference,
} from '../../../../apps/desktop/src/session/renderer/lib/theme/host-theme'

const bootScript = readFileSync('apps/desktop/index.html', 'utf8')
  .match(/<script>([\s\S]*?)<\/script>/)![1]!

beforeEach(() => {
  localStorage.clear()
  delete document.documentElement.dataset.theme
  delete document.documentElement.dataset.themePreference
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
  vi.stubGlobal('electronAPI', undefined)
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete document.documentElement.dataset.theme
  delete document.documentElement.dataset.themePreference
  localStorage.clear()
})

describe('plain white theme preference', () => {
  it('resolves to light even when the system is dark', () => {
    expect(resolveThemePreference('plain-white')).toBe('light')
  })

  it('persists the distinct preference while selecting the native light scheme', () => {
    const sync = vi.fn(() => 'light' as const)
    vi.stubGlobal('electronAPI', { syncThemePreference: sync })
    expect(writeThemePreference('plain-white')).toBe('light')
    expect(sync).toHaveBeenCalledExactlyOnceWith('light')
    expect(readThemePreference()).toBe('plain-white')
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(document.documentElement.dataset.themePreference).toBe('plain-white')
  })

  it('restores the saved appearance after a reload', () => {
    localStorage.setItem('app-theme', 'plain-white')
    expect(hydrateHostTheme()).toBe('light')
    expect(readThemePreference()).toBe('plain-white')
    expect(document.documentElement.dataset.themePreference).toBe('plain-white')
  })

  it('restores white before first paint through the real HTML bootstrap', () => {
    localStorage.setItem('app-theme', 'plain-white')
    new Function('window', 'document', 'localStorage', bootScript)(window, document, localStorage)
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(document.documentElement.dataset.themePreference).toBe('plain-white')
  })

  it('keeps the default light preference and explicit dark/system behavior', () => {
    expect(readThemePreference()).toBe('light')
    expect(hydrateHostTheme()).toBe('light')
    writeThemePreference('plain-white')
    expect(writeThemePreference('dark')).toBe('dark')
    expect(readThemePreference()).toBe('dark')
    expect(document.documentElement.dataset.themePreference).not.toBe('plain-white')
    expect(writeThemePreference('system')).toBe('dark')
  })
})
