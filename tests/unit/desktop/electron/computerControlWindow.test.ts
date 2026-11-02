import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computerBarBounds, resolveComputerWindow } from '../../../../apps/desktop/electron/device-actions/computer-control-placement'
import { createComputerControlWindow } from '../../../../apps/desktop/electron/device-actions/computer-control-window'
import { createComputerControl } from '../../../../apps/desktop/electron/device-actions/computer-control'
import { createComputerFamily } from '../../../../apps/desktop/electron/device-actions/families/computer'
import type { ActionRunContext } from '../../../../apps/desktop/electron/device-actions/catalog'

type FakeWindow = {
  visible: boolean
  setBounds: ReturnType<typeof vi.fn>
  hide: ReturnType<typeof vi.fn>
  showInactive: ReturnType<typeof vi.fn>
  moveAbove: ReturnType<typeof vi.fn>
  webContents: { executeJavaScript: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> }
}
const native = vi.hoisted(() => ({ windows: [] as FakeWindow[], load: null as Promise<void> | null, area: { x: 0, y: 0, width: 1440, height: 900 } }))
vi.mock('electron', () => ({
  screen: {
    getPrimaryDisplay: () => ({ workArea: native.area }),
    getDisplayMatching: () => ({ workArea: native.area }),
  },
  BrowserWindow: class {
    visible = false
    setBounds = vi.fn()
    hide = vi.fn(() => { this.visible = false })
    showInactive = vi.fn(() => { this.visible = true })
    isVisible = () => this.visible
    isDestroyed = () => false
    loadURL = async () => { await native.load }
    on = vi.fn()
    setAlwaysOnTop = vi.fn()
    isAlwaysOnTop = () => false
    moveAbove = vi.fn()
    setVisibleOnAllWorkspaces = vi.fn()
    setContentProtection = vi.fn()
    webContents = { on: vi.fn(), setWindowOpenHandler: vi.fn(), executeJavaScript: vi.fn(async () => undefined) }
    constructor() { native.windows.push(this) }
  },
}))

const window = (windowId = 11, x = 100) => ({ pid: 7, window_id: windowId, is_on_screen: true, on_current_space: true, layer: 0, bounds: { x, y: 100, width: 600, height: 400 } })
const result = (...windows: unknown[]) => ({ structuredContent: { windows } })
const strings = () => ({ driving: (name: string) => name, paused: (name: string) => name, stop: 'Stop', resume: 'Continue', someone: 'Agent' })
const view = (windowId = 11) => ({ state: 'driving' as const, callerName: 'Agent A', app: { pid: 7, windowId, name: 'Notes' } })

beforeEach(() => {
  vi.useFakeTimers()
  native.windows.length = 0
  native.load = null
  native.area = { x: 0, y: 0, width: 1440, height: 900 }
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

describe('window-relative computer indicator', () => {
  it('runs computer acts through the family with only a target-window indicator', async () => {
    const bar = createComputerControlWindow({ readWindows: async () => result(window()), strings, onStop: vi.fn(), onResume: vi.fn() })
    const control = createComputerControl({ view: bar })
    const callTool = vi.fn(async () => result({ ...window(), app_name: 'Notes' }))
    const ctx = {
      deps: { platform: 'darwin', computerControl: control, cua: () => ({ callTool }) },
      caller: { name: 'Agent A' }, signal: new AbortController().signal, note: vi.fn(),
    } as unknown as ActionRunContext
    const family = createComputerFamily(null)
    expect(await family.actions.find(a => a.name === 'computer.move_cursor')!.run({ x: 1, y: 1 }, ctx)).toHaveProperty('ok', true)
    await vi.advanceTimersByTimeAsync(250)
    expect(native.windows).toHaveLength(0)
    expect(await family.actions.find(a => a.name === 'computer.click')!.run({ pid: 7, window_id: 11, x: 1, y: 1 }, ctx)).toHaveProperty('ok', true)
    await vi.advanceTimersByTimeAsync(250)
    expect(native.windows).toHaveLength(1)
    expect(native.windows[0]!.moveAbove).toHaveBeenLastCalledWith('window:11:0')
    expect(native.windows[0]!.setBounds).toHaveBeenLastCalledWith({ x: 246, y: 57, width: 236, height: 44 })
    control.dispose()
  })

  it('never creates a desktop indicator for targetless operations, including paused views', async () => {
    const readWindows = vi.fn(async () => result(window()))
    const bar = createComputerControlWindow({ readWindows, strings, onStop: vi.fn(), onResume: vi.fn() })
    const control = createComputerControl({ view: bar })
    const handle = control.begin({ callerName: 'Agent A' })
    expect(handle).not.toHaveProperty('refused')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(native.windows).toHaveLength(0)
    control.stop()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(native.windows).toHaveLength(0)
    expect(readWindows).not.toHaveBeenCalled()
    if ('end' in handle) handle.end()
    control.dispose()
  })

  it('creates only the attached indicator during an operation and keeps its Stop/Continue navigation', async () => {
    const readWindows = vi.fn(async () => result(window()))
    const bar = createComputerControlWindow({ readWindows, strings, onStop: () => control.stop(), onResume: () => control.resume() })
    const control = createComputerControl({ view: bar })
    const handle = control.begin({ pid: 7, windowId: 11, callerName: 'Agent A' })
    if ('refused' in handle) throw new Error(handle.refused)
    await vi.advanceTimersByTimeAsync(0)
    expect(native.windows).toHaveLength(1)
    const w = native.windows[0]!
    expect(w.setBounds).toHaveBeenLastCalledWith({ x: 246, y: 57, width: 236, height: 44 })
    const navigate = w.webContents.on.mock.calls.find(([name]) => name === 'will-navigate')![1]
    const event = { preventDefault: vi.fn() }
    navigate(event, 'gugu-computer-bar:stop')
    await vi.advanceTimersByTimeAsync(250)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(handle.signal.aborted).toBe(true)
    expect(control.begin({ pid: 7, windowId: 11 })).toHaveProperty('refused')
    expect(w.webContents.executeJavaScript).toHaveBeenLastCalledWith(expect.stringContaining('"action":"resume"'))
    navigate(event, 'gugu-computer-bar:resume')
    expect(w.visible).toBe(false)
    const resumed = control.begin({ pid: 7, windowId: 11 })
    expect(resumed).not.toHaveProperty('refused')
    await vi.advanceTimersByTimeAsync(250)
    expect(native.windows).toHaveLength(1)
    handle.end()
    if ('end' in resumed) resumed.end()
    control.dispose()
  })

  it('hides an existing attachment and cancels its lookup when a view has no target', async () => {
    const readWindows = vi.fn(async (_pid: number, _signal: AbortSignal) => result(window()))
    const bar = createComputerControlWindow({ readWindows, strings, onStop: vi.fn(), onResume: vi.fn() })
    bar.show(view())
    await vi.advanceTimersByTimeAsync(0)
    bar.show({ state: 'driving', callerName: 'Agent B' })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(native.windows).toHaveLength(1)
    expect(native.windows[0]!.visible).toBe(false)
    expect(native.windows[0]!.setBounds).toHaveBeenCalledTimes(1)
    expect(readWindows).toHaveBeenCalledOnce()
    expect(readWindows.mock.calls[0]![1].aborted).toBe(true)
    bar.hide()
  })

  it('shows task identity alongside the Agent and clears it when the next call has none', async () => {
    const bar = createComputerControlWindow({ readWindows: async () => result(window()), strings, onStop: vi.fn(), onResume: vi.fn() })
    bar.show({ ...view(), taskTitle: 'Task one' })
    await vi.advanceTimersByTimeAsync(0)
    const render = native.windows[0]!.webContents.executeJavaScript
    expect(render).toHaveBeenLastCalledWith(expect.stringContaining('Agent A · Task one'))
    bar.show({ ...view(), callerName: 'Agent B' })
    await vi.advanceTimersByTimeAsync(250)
    expect(render).toHaveBeenLastCalledWith(expect.stringContaining('Agent B'))
    expect(render.mock.lastCall?.[0]).not.toContain('Task one')
    bar.show({ ...view(), taskTitle: 'Agent A' })
    await vi.advanceTimersByTimeAsync(250)
    expect(render.mock.lastCall?.[0]).not.toContain('Agent A · Agent A')
    expect(render.mock.lastCall?.[0]).not.toContain('taskTitle')
    bar.hide()
  })

  it('matches the exact window, never another window of the same app or an invisible/invalid window', () => {
    expect(resolveComputerWindow(result(window(11), window(12, 800)).structuredContent, { pid: 7, windowId: 12 })?.bounds.x).toBe(800)
    expect(resolveComputerWindow(result(window(11), window(12)).structuredContent, { pid: 7 })).toBeNull()
    for (const change of [{ is_on_screen: false }, { on_current_space: false }, { pid: 8 }, { window_id: 12 }, { bounds: { x: NaN, y: 0, width: 10, height: 10 } }]) {
      expect(resolveComputerWindow(result({ ...window(), ...change }).structuredContent, { pid: 7, windowId: 11 })).toBeNull()
    }
  })

  it('anchors to the window on a display with a negative origin; narrows inside a small or partially offscreen window', () => {
    expect(computerBarBounds({ x: -1200, y: -800, width: 700, height: 500 }, { x: -1440, y: -900, width: 1440, height: 900 }))
      .toEqual({ x: -1010, y: -843, width: 236, height: 44 })
    expect(computerBarBounds({ x: -50, y: 10, width: 300, height: 200 }, native.area))
      .toEqual({ x: 8, y: 10, width: 234, height: 44 })
    expect(computerBarBounds({ x: 0, y: 0, width: 100, height: 100 }, native.area)).toBeNull()
  })

  it('follows moves and resizes, hides on minimize/close, and resumes on restore without stealing focus', async () => {
    const readWindows = vi.fn(async () => result(window()))
    const bar = createComputerControlWindow({ readWindows, strings, onStop: vi.fn(), onResume: vi.fn() })
    bar.show(view())
    await vi.advanceTimersByTimeAsync(0)
    const w = native.windows[0]!
    expect(w.setBounds).toHaveBeenLastCalledWith({ x: 246, y: 57, width: 236, height: 44 })
    expect(w.webContents.executeJavaScript).toHaveBeenLastCalledWith(expect.stringContaining('"attachment":"above"'))
    expect(w.moveAbove).toHaveBeenLastCalledWith('window:11:0')
    readWindows.mockResolvedValue(result({ ...window(11, 400), bounds: { x: 400, y: 20, width: 300, height: 200 } }))
    await vi.advanceTimersByTimeAsync(250)
    expect(w.setBounds).toHaveBeenLastCalledWith({ x: 414, y: 20, width: 236, height: 44 })
    expect(w.webContents.executeJavaScript).toHaveBeenLastCalledWith(expect.stringContaining('"attachment":"inside"'))
    readWindows.mockResolvedValue(result())
    await vi.advanceTimersByTimeAsync(250)
    expect(w.visible).toBe(false)
    readWindows.mockResolvedValue(result(window()))
    await vi.advanceTimersByTimeAsync(250)
    expect(w.visible).toBe(true)
    expect(w.showInactive).toHaveBeenCalledTimes(2)
    bar.hide()
    const count = readWindows.mock.calls.length
    await vi.advanceTimersByTimeAsync(1_000)
    expect(readWindows).toHaveBeenCalledTimes(count)
    expect(w.visible).toBe(false)
  })

  it('ignores late geometry from a previous target and aborts the lookup when hidden', async () => {
    let finish: ((value: ReturnType<typeof result>) => void) | undefined
    const readWindows = vi.fn<(pid: number, signal: AbortSignal) => Promise<ReturnType<typeof result>>>()
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      .mockResolvedValue(result(window(12, 800)))
    const bar = createComputerControlWindow({ readWindows, strings, onStop: vi.fn(), onResume: vi.fn() })
    bar.show(view())
    const oldSignal = readWindows.mock.calls[0]![1]
    bar.show(view(12))
    await vi.advanceTimersByTimeAsync(0)
    const w = native.windows[0]!
    expect(oldSignal.aborted).toBe(true)
    expect(w.setBounds).toHaveBeenLastCalledWith({ x: 946, y: 57, width: 236, height: 44 })
    finish?.(result(window()))
    await vi.advanceTimersByTimeAsync(0)
    expect(w.setBounds).toHaveBeenCalledTimes(1)
    bar.hide()
    expect(readWindows.mock.calls[1]![1].aborted).toBe(true)
    expect(w.visible).toBe(false)
  })

  it('does not resurrect a hidden indicator while its page is loading', async () => {
    let loaded: (() => void) | undefined
    native.load = new Promise(resolve => { loaded = resolve })
    const readWindows = vi.fn(async () => result(window()))
    const bar = createComputerControlWindow({ readWindows, strings, onStop: vi.fn(), onResume: vi.fn() })
    bar.show(view())
    await vi.advanceTimersByTimeAsync(0)
    const w = native.windows[0]!
    expect(w.visible).toBe(false)
    bar.hide()
    loaded?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(w.showInactive).not.toHaveBeenCalled()
    expect(w.visible).toBe(false)
  })

  it('keeps unresolved app targets hidden instead of falling back to the primary display', async () => {
    const bar = createComputerControlWindow({ readWindows: async () => result(window(12)), strings, onStop: vi.fn(), onResume: vi.fn() })
    bar.show(view(11))
    await vi.advanceTimersByTimeAsync(0)
    expect(native.windows).toHaveLength(0)
    bar.hide()
  })
})
