import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QUICK_CHAT_CHANNELS } from '../../../../apps/desktop/src/lib/quickChatIpc'

const native = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  register: vi.fn(),
  owners: new Set<{ enabled: boolean; owned: boolean; foreground: boolean; onChange: (owned: boolean) => void }>(),
  send: vi.fn(),
  writeFileSync: vi.fn(),
}))
vi.mock('node:fs', () => ({
  readFileSync: () => '{}',
  writeFileSync: native.writeFileSync,
}))
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
  app: { getPath: () => '/test-profile', on: vi.fn(), focus: vi.fn() },
  BrowserWindow: class { static getFocusedWindow() { return null } },
  globalShortcut: { register: native.register, unregister: vi.fn() },
  ipcMain: { handle: (name: string, handler: (...args: unknown[]) => unknown) => native.handlers.set(name, handler) },
  screen: {
    getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  },
}))
const { installQuickChat } = await import('../../../../apps/desktop/electron/quick-chat-window')

class TestWindow extends EventEmitter {
  visible = false
  webContents = Object.assign(new EventEmitter(), { send: native.send })
  isDestroyed = () => false
  isVisible = () => this.visible
  isFocused = () => this.visible
  setBounds = vi.fn()
  bounds = { x: 100, y: 100, width: 520, height: 680 }
  getBounds = () => this.bounds
  setAlwaysOnTop = vi.fn()
  focus = vi.fn()
  show = vi.fn(() => { this.visible = true; this.emit('show') })
  hide = vi.fn(() => { this.visible = false; this.emit('hide') })
}
const asWindow = (win: TestWindow) => win as unknown as BrowserWindow

function setup() {
  const main = new TestWindow()
  const child = new TestWindow()
  const quick = installQuickChat({ mainWindow: () => asWindow(main), focusMain: vi.fn(), supported: true })
  quick.auxWindow.adopt(asWindow(child))
  return { main, child, quick }
}

/** 读出最后一次写盘的内容。 */
function lastWritten(): { bounds?: { x: number; y: number; width: number; height: number } } | undefined {
  const call = native.writeFileSync.mock.calls.at(-1)
  if (!call) return undefined
  return JSON.parse(String(call[1])) as { bounds?: { x: number; y: number; width: number; height: number } }
}

beforeEach(() => {
  native.handlers.clear()
  native.owners.clear()
  vi.clearAllMocks()
  native.register.mockReturnValue(true)
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('快速聊天窗口的位置记录', () => {
  it('一串拖动事件只写一次盘,写的是最后那个位置', () => {
    const { child } = setup()
    // 拖动:几十个 moved 事件,位置一路变。
    for (let i = 0; i < 50; i++) {
      child.bounds = { x: 100 + i, y: 200 + i, width: 520, height: 680 }
      child.emit('moved')
    }
    // 这一轮还没到落盘时间 ⇒ 还没写(写盘会卡主进程)。
    expect(native.writeFileSync).not.toHaveBeenCalled()

    vi.advanceTimersByTime(300)
    expect(native.writeFileSync).toHaveBeenCalledTimes(1)
    expect(lastWritten()?.bounds).toEqual({ x: 149, y: 249, width: 520, height: 680 })
  })

  it('拖动停下来之后又拖一次,再写一次', () => {
    const { child } = setup()
    child.bounds = { x: 10, y: 20, width: 520, height: 680 }
    child.emit('moved')
    vi.advanceTimersByTime(300)
    expect(native.writeFileSync).toHaveBeenCalledTimes(1)

    child.bounds = { x: 30, y: 40, width: 520, height: 680 }
    child.emit('moved')
    vi.advanceTimersByTime(300)
    expect(native.writeFileSync).toHaveBeenCalledTimes(2)
    expect(lastWritten()?.bounds).toEqual({ x: 30, y: 40, width: 520, height: 680 })
  })

  it('拖动持续得比等待时间还长时,分段写,不是从头到尾只写一次', () => {
    const { child } = setup()
    // 反例:一个「攒到拖完才写」的实现,在拖得久的时候一次都不写 —— 用户拖到一半换了个位置,
    // 中间的位置就永远丢了。所以这里拖得比等待窗口还久,应该分段落盘。
    child.bounds = { x: 1, y: 1, width: 520, height: 680 }
    child.emit('moved')
    vi.advanceTimersByTime(100)
    child.bounds = { x: 2, y: 2, width: 520, height: 680 }
    child.emit('moved')
    vi.advanceTimersByTime(100)
    child.bounds = { x: 3, y: 3, width: 520, height: 680 }
    child.emit('moved')
    // 已经过了 300ms ⇒ 第一段该落了。
    vi.advanceTimersByTime(100)
    expect(native.writeFileSync).toHaveBeenCalledTimes(1)
    expect(lastWritten()?.bounds).toEqual({ x: 3, y: 3, width: 520, height: 680 })

    // 又拖了一段,停下来又写一次。
    child.bounds = { x: 4, y: 4, width: 520, height: 680 }
    child.emit('moved')
    vi.advanceTimersByTime(300)
    expect(native.writeFileSync).toHaveBeenCalledTimes(2)
    expect(lastWritten()?.bounds).toEqual({ x: 4, y: 4, width: 520, height: 680 })
  })

  it('窗真被关掉时,还没落盘的位置要写下去', () => {
    const { child } = setup()
    child.bounds = { x: 55, y: 66, width: 520, height: 680 }
    child.emit('moved')
    expect(native.writeFileSync).not.toHaveBeenCalled()

    child.emit('closed')
    expect(native.writeFileSync).toHaveBeenCalledTimes(1)
    expect(lastWritten()?.bounds).toEqual({ x: 55, y: 66, width: 520, height: 680 })
  })

  it('小窗被收起来时,还没落盘的位置要写下去', () => {
    const { child } = setup()
    child.show()
    child.bounds = { x: 77, y: 88, width: 520, height: 680 }
    child.emit('moved')
    expect(native.writeFileSync).not.toHaveBeenCalled()

    // 收起(而不是真关)也要落盘 —— 否则下次出来用的还是拖动前的位置。
    native.handlers.get(QUICK_CHAT_CHANNELS.hide)!({})
    expect(native.writeFileSync).toHaveBeenCalledTimes(1)
    expect(lastWritten()?.bounds).toEqual({ x: 77, y: 88, width: 520, height: 680 })
  })
})
