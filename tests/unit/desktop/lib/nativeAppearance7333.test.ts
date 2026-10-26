// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyNativeThemePreference,
  installNativeAppearanceSync,
  type NativeAppearanceTheme,
} from '../../../../apps/desktop/electron/window-material'
import { WINDOW_THEME_PREFERENCE_CHANNEL } from '../../../../apps/desktop/shared/window-material'
import {
  hydrateHostTheme,
  NativeAppearanceSyncError,
  startHostThemeSystemSync,
  writeThemePreference,
} from '../../../../apps/desktop/src/session/renderer/lib/theme/host-theme'

/** A fake nativeTheme: shouldUseDarkColors follows themeSource, and the OS appearance when themeSource is 'system'. */
function fakeNativeTheme(osDark: boolean) {
  const theme = {
    osDark,
    themeSource: 'system' as NativeAppearanceTheme['themeSource'],
    get shouldUseDarkColors() {
      return this.themeSource === 'system' ? this.osDark : this.themeSource === 'dark'
    },
  }
  return theme
}

describe('native appearance follows the theme preference on mac (#7333)', () => {
  it('copies the preference — not the resolved tone — into themeSource, and answers the real tone', () => {
    const theme = fakeNativeTheme(false)
    expect(applyNativeThemePreference('darwin', theme, 'dark')).toBe('dark')
    expect(theme.themeSource).toBe('dark')
    // Back to following the system: themeSource is 'system' again, and the answer is the OS appearance.
    expect(applyNativeThemePreference('darwin', theme, 'system')).toBe('light')
    expect(theme.themeSource).toBe('system')
  })

  it('leaves Windows/Linux alone: their tray icon reads shouldUseDarkColors to match the taskbar', () => {
    const theme = fakeNativeTheme(false)
    expect(applyNativeThemePreference('win32', theme, 'dark')).toBe('light')
    expect(theme.themeSource).toBe('system')
  })

  it('refuses an invalid preference through the existing invoke handler', () => {
    expect(() => applyNativeThemePreference('darwin', fakeNativeTheme(false), 'sepia')).toThrow(/light \/ dark \/ system/)
    let handler: ((event: { sender: unknown }, ...args: unknown[]) => unknown) | null = null
    installNativeAppearanceSync({
      platform: 'darwin',
      nativeTheme: fakeNativeTheme(false),
      ipcMain: { handle: (channel, listener) => { if (channel === WINDOW_THEME_PREFERENCE_CHANNEL) handler = listener } },
    })
    expect(() => handler!({ sender: {} }, 'sepia')).toThrow(/light \/ dark \/ system/)
  })
})

/**
 * The renderer side, against a fake main process. The fake matchMedia lags behind themeSource the way Chromium does:
 * it only sees the new appearance after `flush()` — which is exactly the window where a stale read would paint a wrong frame.
 */
describe('the renderer settles the theme through the main process (#7333)', () => {
  let main: ReturnType<typeof fakeNativeTheme>
  let mqDark = false
  const mqListeners = new Set<() => void>()
  const writes: string[] = []
  let observer: MutationObserver
  const flush = () => {
    const next = main.shouldUseDarkColors
    if (next === mqDark) return
    mqDark = next
    for (const listener of mqListeners) listener()
  }

  beforeEach(() => {
    main = fakeNativeTheme(false)
    mqDark = false
    mqListeners.clear()
    writes.length = 0
    localStorage.clear()
    delete document.documentElement.dataset.theme
    window.matchMedia = ((query: string) => ({
      media: query,
      get matches() { return mqDark },
      addEventListener: (_: string, listener: () => void) => mqListeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => mqListeners.delete(listener),
    })) as unknown as typeof window.matchMedia
    window.electronAPI = {
      ...(window.electronAPI ?? {}),
      syncThemePreference: async (preference: 'light' | 'dark' | 'system') => applyNativeThemePreference('darwin', main, preference),
    } as typeof window.electronAPI
    observer = new MutationObserver(() => writes.push(document.documentElement.dataset.theme ?? ''))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  })
  afterEach(() => observer.disconnect())

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

  it('restores a stored hand-picked theme at start and puts the native appearance on it', async () => {
    localStorage.setItem('app-theme', 'dark')
    expect(await hydrateHostTheme()).toBe('dark')
    expect(main.themeSource).toBe('dark')
    await settle()
    expect(document.documentElement.dataset.theme).toBe('dark')
  })

  it('hand-picking light or dark moves the native appearance with it', async () => {
    await writeThemePreference('dark')
    expect(main.themeSource).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    await writeThemePreference('light')
    expect(main.themeSource).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('does not commit the preference or theme while the native reply is pending', async () => {
    let answer!: (tone: 'light' | 'dark') => void
    window.electronAPI = {
      ...window.electronAPI,
      syncThemePreference: () => new Promise<'light' | 'dark'>((resolve) => { answer = resolve }),
    } as typeof window.electronAPI
    localStorage.setItem('app-theme', 'light')
    document.documentElement.dataset.theme = 'light'
    const pending = writeThemePreference('system')
    expect(localStorage.getItem('app-theme')).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')
    answer('dark')
    await pending
    expect(localStorage.getItem('app-theme')).toBe('system')
    expect(document.documentElement.dataset.theme).toBe('dark')
  })

  it('going back to the system paints the real system tone first, not the stale matchMedia one', async () => {
    const release = startHostThemeSystemSync()
    try {
      await writeThemePreference('dark')
      flush() // Chromium catches up: matchMedia now says dark (because themeSource is dark)
      await settle()
      writes.length = 0
      await writeThemePreference('system') // OS is light; matchMedia still says dark until the next flush
      expect(document.documentElement.dataset.theme).toBe('light')
      flush()
      await settle()
      expect(writes.every((value) => value === 'light')).toBe(true)
    } finally {
      release()
    }
  })

  it('after that, a change of the system appearance still reaches data-theme', async () => {
    const release = startHostThemeSystemSync()
    try {
      await writeThemePreference('system')
      main.osDark = true
      flush()
      await settle()
      expect(document.documentElement.dataset.theme).toBe('dark')
    } finally {
      release()
    }
  })

  describe('when the bridge is there but the main process cannot answer', () => {
    beforeEach(() => {
      window.electronAPI = { ...(window.electronAPI ?? {}), syncThemePreference: async () => { throw new NativeAppearanceSyncError('native appearance failed') } } as typeof window.electronAPI
    })

    it('a pick is refused loudly and leaves the stored preference and data-theme as they were', async () => {
      localStorage.setItem('app-theme', 'light')
      document.documentElement.dataset.theme = 'light'
      await expect(writeThemePreference('dark')).rejects.toThrow(NativeAppearanceSyncError)
      expect(localStorage.getItem('app-theme')).toBe('light')
      expect(document.documentElement.dataset.theme).toBe('light')
    })

    it('start-up restore keeps the theme the boot script already set, and says so', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      localStorage.setItem('app-theme', 'system')
      document.documentElement.dataset.theme = 'dark'
      mqDark = false // a stale/disagreeing matchMedia must not be used to overwrite it
      expect(await hydrateHostTheme()).toBe('dark')
      expect(document.documentElement.dataset.theme).toBe('dark')
      expect(error).toHaveBeenCalledWith(expect.stringContaining('[theme/native-appearance]'), { preference: 'system', error: expect.stringContaining('native appearance failed') })
      error.mockRestore()
    })
  })
})
