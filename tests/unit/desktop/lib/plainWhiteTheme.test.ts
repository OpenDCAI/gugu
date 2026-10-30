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

describe('retired plain white theme preference', () => {
  it.each([false, true])('reads a legacy saved value as light when system dark is %s', (dark) => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: dark })))
    localStorage.setItem('app-theme', 'plain-white')
    expect(readThemePreference()).toBe('light')
  })

  it('hydrates the legacy value as the ordinary light preference and native scheme', () => {
    const sync = vi.fn(() => 'light' as const)
    vi.stubGlobal('electronAPI', { syncThemePreference: sync })
    localStorage.setItem('app-theme', 'plain-white')
    expect(hydrateHostTheme()).toBe('light')
    expect(sync).toHaveBeenCalledExactlyOnceWith('light')
    expect(readThemePreference()).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(document.documentElement.dataset.themePreference).toBe('light')
  })

  it.each([false, true])('normalizes the legacy value before first paint when system dark is %s', (dark) => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: dark })))
    localStorage.setItem('app-theme', 'plain-white')
    new Function('window', 'document', 'localStorage', bootScript)(window, document, localStorage)
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(document.documentElement.dataset.themePreference).toBe('light')
  })

  it('keeps the default light preference and explicit dark/system behavior', () => {
    expect(readThemePreference()).toBe('light')
    expect(hydrateHostTheme()).toBe('light')
    expect(resolveThemePreference('light')).toBe('light')
    expect(resolveThemePreference('dark')).toBe('dark')
    expect(writeThemePreference('dark')).toBe('dark')
    expect(readThemePreference()).toBe('dark')
    expect(document.documentElement.dataset.themePreference).not.toBe('plain-white')
    expect(writeThemePreference('system')).toBe('dark')
  })

  it('keeps follow-system light when the system uses light', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
    expect(writeThemePreference('system')).toBe('light')
    expect(readThemePreference()).toBe('system')
    expect(document.documentElement.dataset.themePreference).toBe('system')
  })
})
