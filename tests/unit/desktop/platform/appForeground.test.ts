import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { capacitorPlatform } from '../../../../apps/desktop/src/platform/capacitor'
import { electronPlatform } from '../../../../apps/desktop/src/platform/electron'
import { webPlatform } from '../../../../apps/desktop/src/platform/web'

const { appAddListener } = vi.hoisted(() => ({ appAddListener: vi.fn() }))
vi.mock('@capacitor/app', () => ({ App: { addListener: appAddListener } }))

const source = readFileSync(resolve(process.cwd(), 'apps/desktop/src/platform/capacitor.ts'), 'utf8')
const electronSource = readFileSync(resolve(process.cwd(), 'apps/desktop/src/platform/electron.ts'), 'utf8')
const preloadSource = readFileSync(resolve(process.cwd(), 'apps/desktop/electron/preload.ts'), 'utf8')
const mainSource = readFileSync(resolve(process.cwd(), 'apps/desktop/electron/main.ts'), 'utf8')
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('app foreground platform boundary', () => {
  beforeEach(() => appAddListener.mockReset())

  it('confines official App resume registration and exact teardown to the Capacitor adapter', () => {
    expect(source).toMatch(/from '@capacitor\/app'/)
    expect(source).toMatch(/App\.addListener\(['"]resume['"]/)
    expect(source).toMatch(/active\s*=\s*false/)
    expect(source).toMatch(/handle\.remove\(\)/)
    expect(source).toMatch(/catch\([^)]*onError/)
    expect(source).not.toMatch(/gugu:app-foreground|removeAllListeners\([^)]*App/)
  })

  it('forwards official resume only while active and removes the exact handle', async () => {
    const remove = vi.fn(async () => {})
    let resume = () => {}
    appAddListener.mockImplementation(async (_event, listener) => {
      resume = listener
      return { remove }
    })
    const listener = vi.fn()
    const onError = vi.fn()
    const stop = capacitorPlatform.subscribeAppForeground(listener, onError)
    await flush()

    resume()
    expect(listener).toHaveBeenCalledOnce()
    stop()
    stop()
    resume()
    expect(listener).toHaveBeenCalledOnce()
    expect(remove).toHaveBeenCalledOnce()
    expect(onError).not.toHaveBeenCalled()
  })

  it('routes Electron focus and system wake to the renderer adapter', () => {
    expect(electronSource).toMatch(/onAppForeground/)
    expect(preloadSource).toMatch(/ipcRenderer\.on\('app:foreground'/)
    expect(mainSource).toMatch(
      /powerMonitor\.on\('resume',\s*\(\)\s*=>\s*\{[\s\S]*notifyRendererForeground\(\)/,
    )
  })

  it('reports exact handle removal failure without an unhandled rejection', async () => {
    const failure = new Error('remove failed')
    appAddListener.mockResolvedValueOnce({ remove: vi.fn(async () => { throw failure }) })
    const onError = vi.fn()
    const stop = capacitorPlatform.subscribeAppForeground(vi.fn(), onError)
    await flush()
    stop()
    await flush()
    expect(onError).toHaveBeenCalledOnce()
    expect(onError).toHaveBeenCalledWith(failure)
  })

  it('removes a deferred handle after stop and observes registration rejection', async () => {
    let resolveHandle!: (handle: { remove: () => Promise<void> }) => void
    const remove = vi.fn(async () => {})
    appAddListener.mockReturnValueOnce(new Promise((resolve) => { resolveHandle = resolve }))
    const onError = vi.fn()
    const stop = capacitorPlatform.subscribeAppForeground(vi.fn(), onError)
    stop()
    resolveHandle({ remove })
    await flush()
    expect(remove).toHaveBeenCalledOnce()

    const failure = new Error('registration failed')
    appAddListener.mockRejectedValueOnce(failure)
    capacitorPlatform.subscribeAppForeground(vi.fn(), onError)
    await flush()
    expect(onError).toHaveBeenCalledWith(failure)
  })

  it('wires Electron foreground events through preload and keeps Web a no-op', () => {
    const listener = vi.fn()
    const onError = vi.fn()
    const remove = vi.fn()
    const onAppForeground = vi.fn(() => remove)
    vi.stubGlobal('window', { electronAPI: { onAppForeground } })
    const stop = electronPlatform.subscribeAppForeground(listener, onError)
    expect(onAppForeground).toHaveBeenCalledWith(listener)
    stop()
    expect(remove).toHaveBeenCalledOnce()
    webPlatform.subscribeAppForeground(listener, onError)()
    expect(listener).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
