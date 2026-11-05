import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QUICK_CHAT_CHANNELS } from '../../../../apps/desktop/src/lib/quickChatIpc'

const native = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  register: vi.fn(),
  owners: new Set<{ enabled: boolean; owned: boolean; foreground: boolean; onChange: (owned: boolean) => void }>(),
  appEvents: new Map<string, Array<(...args: unknown[]) => void>>(),
  send: vi.fn(),
}))
vi.mock('node:fs', () => ({ readFileSync: () => '{}', writeFileSync: vi.fn() }))
vi.mock('../../../../apps/desktop/electron/lib/logger', () => ({ createLogger: () => ({ warn: vi.fn() }) }))
vi.mock('../../../../apps/desktop/electron/quick-chat-shortcut-owner', () => ({
  quickChatOwnerPort: () => 12345,
  createQuickChatShortcutOwner: ({ onChange }: { onChange: (owned: boolean) => void }) => {
    const candidate = { enabled: false, owned: false, foreground: false, onChange }
    native.owners.add(candidate)
    const elect = () => {
      const held = [...native.owners].find((item) => item.enabled && item.owned)
      const winner = [...native.owners].findLast((item) => item.enabled && item.foreground) ?? held ?? [...native.owners].find((item) => item.enabled)
      for (const item of native.owners) {
        const next = item === winner
        if (next !== item.owned) { item.owned = next; item.onChange(next) }
      }
    }
    return {
      owns: () => candidate.owned,
      setForeground(next: boolean) { candidate.foreground = next; elect() },
      setEnabled(next: boolean) { candidate.enabled = next; elect() },
      dispose() { candidate.enabled = false; elect(); native.owners.delete(candidate) },
    }
  },
}))
vi.mock('electron', () => ({
  app: { getPath: () => '/test-profile', on: (name: string, fn: (...args: unknown[]) => void) => { native.appEvents.set(name, [...(native.appEvents.get(name) ?? []), fn]) }, focus: vi.fn() },
  BrowserWindow: class { static getFocusedWindow() { return null } },
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
  focused: boolean | null = null
  webContents = Object.assign(new EventEmitter(), { send: native.send })
  isDestroyed = () => false
  isVisible = () => this.visible
  isFocused = () => this.focused ?? this.visible
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
  native.owners.clear()
  native.appEvents.clear()
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

afterEach(() => { vi.useRealTimers() })

describe('#255 cross-instance shortcut focus', () => {
  it('responds in only one ready instance even if macOS accepts both registrations', () => {
    const a = setup()
    const b = setup()
    // Carbon can accept both registrations and broadcast the same physical key.
    for (const [, callback] of native.register.mock.calls) callback()
    expect(Number(a.child.visible) + Number(b.child.visible)).toBe(1)
  })

  it('does not interrupt composition in A when B has no ready auxiliary window', () => {
    vi.useFakeTimers()
    const a = setup()
    a.child.show()
    const composing = { text: '拼', active: true }
    const bMain = new TestWindow()
    bMain.focused = false
    const focusB = vi.fn(() => { composing.active = false })
    installQuickChat({ mainWindow: () => asWindow(bMain), focusMain: focusB, supported: true })
    for (const [, callback] of native.register.mock.calls.slice(1)) callback()
    vi.advanceTimersByTime(1500)
    expect(focusB).not.toHaveBeenCalled()
    expect(composing).toEqual({ text: '拼', active: true })
  })

  it('expires a pending open when its main window loses focus, including late adoption', () => {
    vi.useFakeTimers()
    const main = new TestWindow()
    main.focused = true
    const focusMain = vi.fn()
    const quick = installQuickChat({ mainWindow: () => asWindow(main), focusMain, supported: true })
    const callback = native.register.mock.calls[0]![1] as () => void
    callback()
    main.focused = false
    main.emit('blur')
    for (const fn of native.appEvents.get('browser-window-blur') ?? []) fn({}, main)
    const child = new TestWindow()
    quick.auxWindow.adopt(asWindow(child))
    vi.advanceTimersByTime(1500)
    expect(child.show).not.toHaveBeenCalled()
    expect(focusMain).not.toHaveBeenCalled()
  })
})


describe('#255 pending intent and native registration lifetime', () => {
  it('allows a foreground request to adopt its window before expiry', () => {
    vi.useFakeTimers()
    const main = new TestWindow()
    main.focused = true
    const focusMain = vi.fn()
    const quick = installQuickChat({ mainWindow: () => asWindow(main), focusMain, supported: true })
    native.register.mock.calls[0]![1]()
    expect(native.send).toHaveBeenCalledWith(QUICK_CHAT_CHANNELS.open, undefined)
    const child = new TestWindow()
    quick.auxWindow.adopt(asWindow(child))
    expect(child.show).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(1500)
    expect(focusMain).not.toHaveBeenCalled()
  })

  it('expires a foreground request instead of focusing its main window later', () => {
    vi.useFakeTimers()
    const main = new TestWindow()
    main.focused = true
    const focusMain = vi.fn()
    const quick = installQuickChat({ mainWindow: () => asWindow(main), focusMain, supported: true })
    native.register.mock.calls[0]![1]()
    vi.advanceTimersByTime(1500)
    const child = new TestWindow()
    quick.auxWindow.adopt(asWindow(child))
    expect(child.show).not.toHaveBeenCalled()
    expect(focusMain).not.toHaveBeenCalled()
  })

  it('rejects a queued native callback after disabling, while handing ownership to B', () => {
    const a = setup()
    const setA = native.handlers.get(QUICK_CHAT_CHANNELS.setEnabled)!
    const oldCallback = native.register.mock.calls[0]![1] as () => void
    const b = setup()
    setA({}, false)
    oldCallback()
    expect(a.child.show).not.toHaveBeenCalled()
    native.register.mock.calls.at(-1)![1]()
    expect(b.child.show).toHaveBeenCalledOnce()
  })

  it('does not show a late auxiliary window after disabling its pending request', () => {
    vi.useFakeTimers()
    const main = new TestWindow()
    main.focused = true
    const quick = installQuickChat({ mainWindow: () => asWindow(main), focusMain: vi.fn(), supported: true })
    native.register.mock.calls[0]![1]()
    native.handlers.get(QUICK_CHAT_CHANNELS.setEnabled)!({}, false)
    const child = new TestWindow()
    quick.auxWindow.adopt(asWindow(child))
    expect(child.show).not.toHaveBeenCalled()
  })

  it('preserves explicit user requests to open the main window', () => {
    const { focusMain } = setup()
    native.handlers.get(QUICK_CHAT_CHANNELS.openMain)!({})
    expect(focusMain).toHaveBeenCalledOnce()
  })

  it('does not create a native registration in unsupported server mode', () => {
    const main = new TestWindow()
    main.focused = true
    installQuickChat({ mainWindow: () => asWindow(main), focusMain: vi.fn(), supported: false })
    expect(native.register).not.toHaveBeenCalled()
    expect(native.handlers.get(QUICK_CHAT_CHANNELS.state)!({})).toMatchObject({ supported: false, enabled: false, registered: false })
  })
})


it('#255 hands the shortcut from a background ready B to the newly focused A', () => {
  const b = setup()
  const a = setup()
  a.main.focused = true
  for (const fn of native.appEvents.get('browser-window-focus') ?? []) fn({}, a.main)
  for (const [, callback] of native.register.mock.calls) callback()
  expect(b.child.show).not.toHaveBeenCalled()
  expect(a.child.show).toHaveBeenCalledOnce()
})
