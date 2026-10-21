// @vitest-environment jsdom
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

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

function emitIpc(channel: string, sender: unknown): void {
  const handler = electronMock.handlers.get(channel)
  if (!handler) throw new Error(`missing mocked IPC handler ${channel}`)
  handler({ sender })
}

describe('renderer auth response timeout', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('fails the first unresponsive auth command outward instead of silently replaying it', async () => {
    vi.useFakeTimers()
    vi.resetModules()
    electronMock.handlers.clear()
    const bridge = await import('../../../../apps/desktop/electron/ipc-bridge')
    bridge.setupRendererCommandIpcHandlers()
    const window = fakeWindow()
    bridge.setMainWindow(window as never)
    emitIpc('auth:cmd:ready', window.webContents)

    let settlement: 'pending' | 'resolved' | 'rejected' = 'pending'
    let rejection: unknown
    const result = bridge.invokeRendererAuth('getSessionTokens', {})
    void result.then(
      () => { settlement = 'resolved' },
      (error: unknown) => {
        settlement = 'rejected'
        rejection = error
      },
    )

    await vi.advanceTimersByTimeAsync(30_000)

    expect(settlement).toBe('rejected')
    expect(rejection).toEqual(expect.objectContaining({ message: 'IPC timeout: auth:cmd/getSessionTokens' }))
    expect(window.webContents.send).toHaveBeenCalledOnce()
  })
})
