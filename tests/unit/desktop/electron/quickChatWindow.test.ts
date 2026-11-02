import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QUICK_CHAT_CHANNELS } from '../../../../apps/desktop/src/lib/quickChatIpc'

const native = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  register: vi.fn(),
  send: vi.fn(),
}))
vi.mock('node:fs', () => ({ readFileSync: () => '{}', writeFileSync: vi.fn() }))
vi.mock('electron', () => ({
  app: { getPath: () => '/test-profile', on: vi.fn(), focus: vi.fn() },
  BrowserWindow: class {},
  globalShortcut: { register: native.register, unregister: vi.fn() },
  ipcMain: { handle: (name: string, handler: (...args: unknown[]) => unknown) => native.handlers.set(name, handler) },
  screen: {
    getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  },
}))
const { installQuickChat, quickChatWindowOptions } = await import('../../../../apps/desktop/electron/quick-chat-window')

class TestWindow extends EventEmitter {
  visible = false
  webContents = Object.assign(new EventEmitter(), { send: native.send })
  isDestroyed = () => false
  isVisible = () => this.visible
  isFocused = () => this.visible
  setBounds = vi.fn()
  getBounds = () => ({ x: 100, y: 100, width: 520, height: 680 })
  setAlwaysOnTop = vi.fn()
  focus = vi.fn()
  show = vi.fn(() => { this.visible = true; this.emit('show') })
  hide = vi.fn(() => { this.visible = false; this.emit('hide') })
}
const asWindow = (win: TestWindow) => win as unknown as BrowserWindow
function setup() {
  const main = new TestWindow()
  const child = new TestWindow()
  const focusMain = vi.fn()
  const quick = installQuickChat({ mainWindow: () => asWindow(main), focusMain, supported: true })
  quick.auxWindow.adopt(asWindow(child))
  return { main, child, focusMain, quick }
}
beforeEach(() => {
  native.handlers.clear()
  vi.clearAllMocks()
  native.register.mockReturnValue(true)
})

describe('Quick Chat native visibility', () => {
  it('keeps the pre-created window hidden until the explicit shortcut', () => {
    expect(quickChatWindowOptions('#000').show).toBe(false)
    const { child } = setup()
    expect(child.show).not.toHaveBeenCalled()
    expect(child.visible).toBe(false)
    const toggle = native.register.mock.calls[0]![1] as () => void
    toggle()
    expect(child.visible).toBe(true)
    expect(native.send).toHaveBeenLastCalledWith(QUICK_CHAT_CHANNELS.visibility, true)
  })

  it('reports native visibility changes even when they did not use the shortcut', () => {
    const { child } = setup()
    native.send.mockClear()
    child.show()
    expect(native.send).toHaveBeenLastCalledWith(QUICK_CHAT_CHANNELS.visibility, true)
    child.hide()
    expect(native.send).toHaveBeenLastCalledWith(QUICK_CHAT_CHANNELS.visibility, false)
  })

  it('dismisses through the shared Close IPC without needing an assistant', () => {
    const { child } = setup()
    child.show()
    native.handlers.get(QUICK_CHAT_CHANNELS.hide)!({})
    expect(child.visible).toBe(false)
    expect(native.send).toHaveBeenLastCalledWith(QUICK_CHAT_CHANNELS.visibility, false)
  })

  it('dismisses with Escape and prevents the key from reaching the page', () => {
    const { child } = setup()
    child.show()
    const event = { preventDefault: vi.fn() }
    child.webContents.emit('before-input-event', event, { type: 'keyDown', key: 'Escape' })
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(child.visible).toBe(false)
    expect(native.send).toHaveBeenLastCalledWith(QUICK_CHAT_CHANNELS.visibility, false)
  })
})
