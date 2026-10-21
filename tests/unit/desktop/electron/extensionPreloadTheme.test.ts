// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BACKGROUND_PAGE_ARG, EXTENSION_THEME_CHANNEL } from '../../../../apps/desktop/src/session/shared/extensions/bridge-protocol'

/**
 * An App page's preload asks main for the theme the page loads in (EXTENSION_THEME_CHANNEL), synchronously, before any
 * script of the page runs, and hands it to the runtime as `__guguHost.theme` — gugu.js puts it on `<html>` before the
 * first paint. A `<webview>`'s own `prefers-color-scheme` is the OS's (Electron 44, measured 10-10), so without it a light
 * gugu on a dark OS painted every App page dark until the context came.
 */

const electron = vi.hoisted(() => ({
  exposed: {} as Record<string, unknown>,
  sendSync: vi.fn((_channel: string): unknown => 'dark'),
}))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (name: string, api: unknown) => void (electron.exposed[name] = api) },
  ipcRenderer: { invoke: vi.fn(), on: () => undefined, removeListener: () => undefined, sendSync: electron.sendSync },
}))

const argv = [...process.argv]
const loadPreload = async () => {
  vi.resetModules()
  electron.exposed = {}
  await import('../../../../apps/desktop/electron/extension-bridge-preload')
  return electron.exposed.__guguHost as { theme?: unknown } | undefined
}

afterEach(() => {
  process.argv = [...argv]
  electron.sendSync.mockClear()
})

describe('the theme an App page loads in', () => {
  it('a page asks main for it before anything of the page runs, and hands it to the runtime', async () => {
    const host = await loadPreload()
    expect(electron.sendSync.mock.calls).toEqual([[EXTENSION_THEME_CHANNEL]])
    expect(host?.theme).toBe('dark')
  })

  it('a background page is drawn nowhere: nothing asked, no theme', async () => {
    process.argv = [...argv, BACKGROUND_PAGE_ARG]
    const host = await loadPreload()
    expect(electron.sendSync).not.toHaveBeenCalled()
    expect(host && 'theme' in host).toBe(false)
  })

  it('no answer from main is the wiring broken: loud, never a quiet fall back to the OS\'s colours', async () => {
    electron.sendSync.mockReturnValueOnce(undefined)
    await expect(loadPreload()).rejects.toThrow(EXTENSION_THEME_CHANNEL)
  })
})
