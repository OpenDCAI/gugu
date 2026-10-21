// @vitest-environment jsdom
import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const electronMock = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => void>(),
  ipcMain: {
    on: vi.fn((channel: string, handler: (...args: unknown[]) => void) => {
      electronMock.handlers.set(channel, handler)
    }),
  },
}))

vi.mock('electron', () => ({ ipcMain: electronMock.ipcMain }))

function fakeWindow() {
  const webContents = Object.assign(new EventEmitter(), { send: vi.fn() })
  const windowEvents = new EventEmitter()
  return {
    webContents,
    isDestroyed: () => false,
    once: windowEvents.once.bind(windowEvents),
    // 真 BrowserWindow 有 `on`;桥要订阅 enter/leave-full-screen 把全屏推给扩展
    // surface(#2374)。假件缺这个方法时,production 代码在 macOS 上直接抛。
    on: windowEvents.on.bind(windowEvents),
    isFullScreen: () => false,
  }
}

async function loadBridge() {
  vi.resetModules()
  electronMock.handlers.clear()
  electronMock.ipcMain.on.mockClear()
  const bridge = await import('../../../../apps/desktop/electron/ipc-bridge')
  bridge.setupRendererCommandIpcHandlers()
  const window = fakeWindow()
  bridge.setMainWindow(window as never)
  return { bridge, window }
}

function emitIpc(channel: string, sender: unknown, payload?: unknown): void {
  const handler = electronMock.handlers.get(channel)
  if (!handler) throw new Error(`missing mocked IPC handler ${channel}`)
  handler({ sender }, payload)
}

describe('renderer command readiness handshake', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  it('does not send until the renderer declares the domain ready', async () => {
    const { bridge, window } = await loadBridge()
    const result = bridge.invokeRendererAuth('getSessionTokens', {})

    expect(window.webContents.send).not.toHaveBeenCalled()

    emitIpc('auth:cmd:ready', window.webContents)
    await vi.waitFor(() => expect(window.webContents.send).toHaveBeenCalledOnce())
    const request = window.webContents.send.mock.calls[0][1] as { reqId: string }
    emitIpc('auth:cmd:result', window.webContents, { reqId: request.reqId, result: { accessToken: 'token' } })

    await expect(result).resolves.toEqual({ accessToken: 'token' })
  })

  it('invalidates ready on main-frame navigation and waits for the new document', async () => {
    const { bridge, window } = await loadBridge()
    emitIpc('auth:cmd:ready', window.webContents)

    const oldRequest = bridge.invokeRendererAuth('getSessionTokens', {})
    await vi.waitFor(() => expect(window.webContents.send).toHaveBeenCalledOnce())
    window.webContents.emit('did-start-navigation', {}, 'gugu-app://app/', false, true)
    await expect(oldRequest).rejects.toThrow('Renderer navigated before command response')

    const newRequest = bridge.invokeRendererAuth('getSessionTokens', {})
    await Promise.resolve()
    expect(window.webContents.send).toHaveBeenCalledTimes(1)

    emitIpc('auth:cmd:ready', window.webContents)
    await vi.waitFor(() => expect(window.webContents.send).toHaveBeenCalledTimes(2))
    const request = window.webContents.send.mock.calls[1][1] as { reqId: string }
    emitIpc('auth:cmd:result', window.webContents, { reqId: request.reqId, result: null })
    await expect(newRequest).resolves.toBeNull()
  })

  it('rejects a missing readiness declaration distinctly and without sending', async () => {
    vi.useFakeTimers()
    const { bridge, window } = await loadBridge()
    const result = bridge.invokeRendererAuth('getSessionTokens', {})
    const rejection = expect(result).rejects.toThrow('Renderer readiness timeout: auth:cmd')

    await vi.advanceTimersByTimeAsync(30_000)

    await rejection
    expect(window.webContents.send).not.toHaveBeenCalled()
  })
})
