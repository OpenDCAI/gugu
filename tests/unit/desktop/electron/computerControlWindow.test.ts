import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computerBarBounds, resolveComputerWindow } from '../../../../apps/desktop/electron/device-actions/computer-control-placement'
import { createComputerControlWindow } from '../../../../apps/desktop/electron/device-actions/computer-control-window'
import { createComputerControl } from '../../../../apps/desktop/electron/device-actions/computer-control'
import { computerControlWindowReaders } from '../../../../apps/desktop/electron/device-actions/computer-control-foreground'
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
  it('attaches app-name-only input to the foreground window and explicit input to its target', async () => {
    const bar = createComputerControlWindow({ readForegroundWindow: async () => ({ pid: 7, windowId: 11, bounds: window().bounds }), readWindows: async () => result(window()), strings, onStop: vi.fn(), onResume: vi.fn() })
    const control = createComputerControl({ view: bar })
    const callTool = vi.fn(async () => result({ ...window(), app_name: 'Notes' }))
    const ctx = {
      deps: { platform: 'darwin', computerControl: control, cua: () => ({ callTool }) },
      caller: { name: 'Agent A' }, signal: new AbortController().signal, note: vi.fn(),
    } as unknown as ActionRunContext
    const family = createComputerFamily(null)
    expect(await family.actions.find(a => a.name === 'computer.type_text')!.run({ app: 'Notes', text: 'test' }, ctx)).toHaveProperty('ok', true)
    await vi.advanceTimersByTimeAsync(250)
    expect(native.windows).toHaveLength(1)
    expect(native.windows[0]!.moveAbove).toHaveBeenLastCalledWith('window:11:0')
    expect(await family.actions.find(a => a.name === 'computer.click')!.run({ pid: 7, window_id: 11, x: 1, y: 1 }, ctx)).toHaveProperty('ok', true)
    await vi.advanceTimersByTimeAsync(250)
    expect(native.windows).toHaveLength(1)
    expect(native.windows[0]!.moveAbove).toHaveBeenLastCalledWith('window:11:0')
    expect(native.windows[0]!.setBounds).toHaveBeenLastCalledWith({ x: 246, y: 57, width: 236, height: 44 })
    control.dispose()
  })

  it('keeps targetless Stop/Continue on the foreground attachment with global stop semantics', async () => {
    const readWindows = vi.fn(async () => result(window()))
    const bar = createComputerControlWindow({ readForegroundWindow: async () => ({ pid: 7, windowId: 11, bounds: window().bounds }), readWindows, strings, onStop: () => control.stop(), onResume: () => control.resume() })
    const control = createComputerControl({ view: bar })
    const handle = control.begin({ callerName: 'Agent A' })
    expect(handle).not.toHaveProperty('refused')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(native.windows).toHaveLength(1)
    const navigate = native.windows[0]!.webContents.on.mock.calls.find(([name]) => name === 'will-navigate')![1]
    navigate({ preventDefault: vi.fn() }, 'gugu-computer-bar:stop')
    await vi.advanceTimersByTimeAsync(250)
    if ('signal' in handle) expect(handle.signal.aborted).toBe(true)
    expect(control.begin({ pid: 99 })).toHaveProperty('refused')
    await vi.advanceTimersByTimeAsync(250)
    expect(native.windows).toHaveLength(1)
    expect(native.windows[0]!.webContents.executeJavaScript).toHaveBeenLastCalledWith(expect.stringContaining('"action":"resume"'))
    navigate({ preventDefault: vi.fn() }, 'gugu-computer-bar:resume')
    const resumed = control.begin({ callerName: 'Agent A' })
    expect(resumed).not.toHaveProperty('refused')
    if ('end' in resumed) resumed.end()
    expect(readWindows).not.toHaveBeenCalled()
    if ('end' in handle) handle.end()
    control.dispose()
  })

  it('executes unresolved App input even when no foreground Stop control can be attached', async () => {
    const bar = createComputerControlWindow({ readForegroundWindow: async () => null, readWindows: async () => result(), strings, onStop: vi.fn(), onResume: vi.fn() })
    const control = createComputerControl({ view: bar })
    const callTool = vi.fn(async (_name: string) => result())
    const ctx = { deps: { platform: 'darwin', computerControl: control, cua: () => ({ callTool }) }, signal: new AbortController().signal, note: vi.fn() } as unknown as ActionRunContext
    const family = createComputerFamily(null)
    expect(await family.actions.find(a => a.name === 'computer.type_text')!.run({ app: 'Notes', text: 'test' }, ctx)).toHaveProperty('ok', true)
    expect(callTool.mock.calls.filter(([name]) => name === 'type_text')).toHaveLength(1)
    expect(native.windows).toHaveLength(0)
    control.dispose()
  })

  it.each(['Gugu', 'desktop'] as const)('launches before attaching when the foreground is %s, then targets the launched app for clicks', async foreground => {
    const callTool = vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === 'list_apps') return { structuredContent: { apps: foreground === 'Gugu' ? [{ pid: 4242, active: true }] : [] } }
      if (name === 'list_windows' && args.pid === 4242) return result()
      if (name === 'launch_app') {
        expect(native.windows).toHaveLength(0)
        expect(readForegroundWindow).not.toHaveBeenCalled()
        return { structuredContent: { pid: 7, name: 'Calculator', bundle_id: 'com.apple.calculator', windows: [window()], launch_state: { requested: true, process_running: true, window_ready: true } } }
      }
      return result({ ...window(), app_name: 'Calculator' })
    })
    const readers = computerControlWindowReaders(() => ({ callTool }) as never)
    const readForegroundWindow = vi.fn(readers.readForegroundWindow)
    const bar = createComputerControlWindow({ ...readers, readForegroundWindow, strings, onStop: () => control.stop(), onResume: () => control.resume() })
    const control = createComputerControl({ view: bar })
    const ctx = { deps: { platform: 'darwin', computerControl: control, cua: () => ({ callTool }) }, signal: new AbortController().signal, note: vi.fn() } as unknown as ActionRunContext
    const family = createComputerFamily(null)
    expect(await family.actions.find(a => a.name === 'computer.launch_app')!.run({ name: 'Calculator' }, ctx)).toHaveProperty('ok', true)
    await vi.advanceTimersByTimeAsync(0)
    for (const name of ['1', '2', '3']) {
      expect(await family.actions.find(a => a.name === 'computer.click')!.run({ app: 'Calculator', role: 'button', name }, ctx)).toHaveProperty('ok', true)
    }
    await vi.advanceTimersByTimeAsync(0)
    expect(callTool.mock.calls.filter(([name]) => name === 'click')).toHaveLength(3)
    expect(readForegroundWindow).not.toHaveBeenCalled()
    expect(native.windows[0]!.moveAbove).toHaveBeenLastCalledWith('window:11:0')
    const stop = native.windows[0]!.webContents.on.mock.calls.find(([name]) => name === 'will-navigate')![1]
    stop({ preventDefault: vi.fn() }, 'gugu-computer-bar:stop')
    expect(await family.actions.find(a => a.name === 'computer.click')!.run({ app: 'Calculator', role: 'button', name: '4' }, ctx)).toHaveProperty('code', 'revoked')
    stop({ preventDefault: vi.fn() }, 'gugu-computer-bar:resume')
    expect(await family.actions.find(a => a.name === 'computer.click')!.run({ app: 'Calculator', role: 'button', name: '4' }, ctx)).toHaveProperty('ok', true)
    control.dispose()
  })

  it.each(['tool/args', 'shorthand'] as const)('attaches a whole native batch (%s) to its per-step window without consulting the foreground', async shape => {
    const readForegroundWindow = vi.fn(async () => null)
    const bar = createComputerControlWindow({ readForegroundWindow, readWindows: async () => result(window()), strings, onStop: vi.fn(), onResume: vi.fn() })
    const control = createComputerControl({ view: bar })
    const callTool = vi.fn(async (_name: string, _args: Record<string, unknown>) => result({ ...window(), app_name: 'Calculator' }))
    const ctx = { deps: { platform: 'darwin', computerControl: control, cua: () => ({ callTool }) }, signal: new AbortController().signal, note: vi.fn() } as unknown as ActionRunContext
    const args = { steps: ['1', '2', '3'].map(name => {
      const args = { target: { kind: 'window', pid: 7, window_id: 11 }, role: 'button', name }
      return shape === 'tool/args' ? { tool: 'click', args } : { click: args }
    }), delay_ms: 100 }
    expect(await createComputerFamily(null).actions.find(a => a.name === 'computer.run_steps')!.run(args, ctx)).toHaveProperty('ok', true)
    await vi.advanceTimersByTimeAsync(0)
    expect(readForegroundWindow).not.toHaveBeenCalled()
    expect(callTool.mock.calls.filter(([name]) => name === 'run_steps')).toHaveLength(1)
    expect(callTool).toHaveBeenCalledWith('run_steps', expect.objectContaining(args), expect.anything())
    expect(native.windows[0]!.moveAbove).toHaveBeenLastCalledWith('window:11:0')
    control.dispose()
  })

  it('dispatches a mixed-window batch unchanged even when attachment fails', async () => {
    const bar = createComputerControlWindow({ readForegroundWindow: async () => null, readWindows: async () => result(), strings, onStop: vi.fn(), onResume: vi.fn() })
    const control = createComputerControl({ view: bar })
    const callTool = vi.fn(async (_name: string) => result())
    const ctx = { deps: { platform: 'darwin', computerControl: control, cua: () => ({ callTool }) }, signal: new AbortController().signal, note: vi.fn() } as unknown as ActionRunContext
    const args = { steps: [11, 12].map(window_id => ({ click: { pid: 7, window_id, x: 1, y: 1 } })) }
    expect(await createComputerFamily(null).actions.find(a => a.name === 'computer.run_steps')!.run(args, ctx)).toHaveProperty('ok', true)
    expect(callTool.mock.calls.filter(([name]) => name === 'run_steps')).toHaveLength(1)
    expect(callTool).toHaveBeenLastCalledWith('run_steps', expect.objectContaining(args), expect.anything())
    control.dispose()
  })

  it('dispatches a targetless first click and keeps read-only listing outside indicator handling', async () => {
    const readForegroundWindow = vi.fn(async () => null)
    const bar = createComputerControlWindow({ readForegroundWindow, readWindows: async () => result(), strings, onStop: vi.fn(), onResume: vi.fn() })
    const control = createComputerControl({ view: bar })
    const callTool = vi.fn(async () => result(window()))
    const ctx = { deps: { platform: 'darwin', computerControl: control, cua: () => ({ callTool }) }, signal: new AbortController().signal, note: vi.fn() } as unknown as ActionRunContext
    const family = createComputerFamily(null)
    expect(await family.actions.find(a => a.name === 'computer.click')!.run({ x: 1, y: 2 }, ctx)).toHaveProperty('ok', true)
    expect(callTool).toHaveBeenCalledExactlyOnceWith('click', expect.objectContaining({ x: 1, y: 2 }), expect.anything())
    const foregroundReads = readForegroundWindow.mock.calls.length
    expect(await family.actions.find(a => a.name === 'computer.list_windows')!.run({}, ctx)).toHaveProperty('ok', true)
    expect(callTool).toHaveBeenLastCalledWith('list_windows', expect.objectContaining({ session: expect.any(String) }), expect.anything())
    expect(readForegroundWindow).toHaveBeenCalledTimes(foregroundReads)
    control.dispose()
  })

  it.each(['Gugu', 'desktop'] as const)('passes targetless input to native validation with %s in front without inventing a target', async foreground => {
    const readForegroundWindow = async () => foreground === 'Gugu' ? { pid: 4242, windowId: 42, bounds: window().bounds } : null
    const bar = createComputerControlWindow({ readForegroundWindow, readWindows: async () => result(), strings, onStop: vi.fn(), onResume: vi.fn() })
    const control = createComputerControl({ view: bar })
    // Native macOS default window scope rejects bare pixel coordinates. This
    // fixture checks that the wrapper preserves that result, not Stop placement.
    const nativeMessage = 'click: x,y given with no pid/window_id, but scope is "window".'
    const callTool = vi.fn(async () => ({ isError: true, content: [{ type: 'text' as const, text: nativeMessage }], structuredContent: { code: 'desktop_scope_disabled' } }))
    const ctx = { deps: { platform: 'darwin', computerControl: control, selfApp: () => ({ pids: new Set([4242]), names: new Set(['Gugu']) }), cua: () => ({ callTool }) }, signal: new AbortController().signal, note: vi.fn() } as unknown as ActionRunContext
    const click = createComputerFamily(null).actions.find(a => a.name === 'computer.click')!
    expect(await click.run({ x: 1, y: 2 }, ctx)).toMatchObject({ code: 'execution_failed', message: expect.stringContaining('First use computer.launch_app or computer.list_windows') })
    expect(callTool).toHaveBeenCalledExactlyOnceWith('click', { x: 1, y: 2, session: expect.any(String) }, expect.anything())
    // Known Gugu targets still stop before native dispatch, independently of
    // whether its indicator could attach to the foreground.
    expect(await click.run({ pid: 4242, window_id: 42, x: 1, y: 2 }, ctx)).toMatchObject({ code: 'invalid_args', message: expect.stringContaining('咕咕 itself') })
    expect(callTool).toHaveBeenCalledTimes(1)
    control.dispose()
  })

  it('executes input while its indicator is still loading', async () => {
    let loaded!: () => void
    native.load = new Promise<void>((resolve) => { loaded = resolve })
    const bar = createComputerControlWindow({ readForegroundWindow: async () => ({ pid: 7, windowId: 11, bounds: window().bounds }), readWindows: async () => result(window()), strings, onStop: vi.fn(), onResume: vi.fn() })
    const control = createComputerControl({ view: bar })
    const callTool = vi.fn(async (name: string) => {
      if (name === 'list_windows') return result(window())
      return result()
    })
    const ctx = { deps: { platform: 'darwin', computerControl: control, cua: () => ({ callTool }) }, signal: new AbortController().signal, note: vi.fn() } as unknown as ActionRunContext
    const family = createComputerFamily(null)
    const pending = family.actions.find(a => a.name === 'computer.type_text')!.run({ app: 'Notes', text: 'test' }, ctx)
    await vi.advanceTimersByTimeAsync(0)
    expect(await pending).toHaveProperty('ok', true)
    expect(native.windows[0]!.visible).toBe(false)
    loaded()
    await vi.advanceTimersByTimeAsync(0)
    expect(native.windows[0]!.visible).toBe(true)
    expect(callTool.mock.calls.filter(([name]) => name === 'type_text')).toHaveLength(1)
    control.dispose()
  })

  it('creates only the attached indicator during an operation and keeps its Stop/Continue navigation', async () => {
    const readWindows = vi.fn(async () => result(window()))
    const bar = createComputerControlWindow({ readForegroundWindow: async () => null, readWindows, strings, onStop: () => control.stop(), onResume: () => control.resume() })
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

  it('hides and cancels an existing attachment when neither a target nor a foreground window exists', async () => {
    const readWindows = vi.fn(async (_pid: number, _signal: AbortSignal) => result(window()))
    const bar = createComputerControlWindow({ readForegroundWindow: async () => null, readWindows, strings, onStop: vi.fn(), onResume: vi.fn() })
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
    const bar = createComputerControlWindow({ readForegroundWindow: async () => null, readWindows: async () => result(window()), strings, onStop: vi.fn(), onResume: vi.fn() })
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

  it('restores Continue on a new target window after the stopped window closes', async () => {
    let listed = [window(11)]
    const bar = createComputerControlWindow({ readForegroundWindow: async () => null, readWindows: async () => result(...listed), strings, onStop: () => control.stop(), onResume: () => control.resume() })
    const control = createComputerControl({ view: bar })
    const handle = control.begin({ pid: 7, windowId: 11 })
    await vi.advanceTimersByTimeAsync(0)
    const w = native.windows[0]!
    const navigate = w.webContents.on.mock.calls.find(([name]) => name === 'will-navigate')![1]
    navigate({ preventDefault: vi.fn() }, 'gugu-computer-bar:stop')
    listed = []
    await vi.advanceTimersByTimeAsync(250)
    expect(w.visible).toBe(false)
    listed = [window(12)]
    expect(control.begin({ pid: 7, windowId: 12 })).toHaveProperty('refused')
    await vi.advanceTimersByTimeAsync(250)
    expect(w.visible).toBe(true)
    expect(w.moveAbove).toHaveBeenLastCalledWith('window:12:0')
    expect(w.webContents.executeJavaScript).toHaveBeenLastCalledWith(expect.stringContaining('"action":"resume"'))
    navigate({ preventDefault: vi.fn() }, 'gugu-computer-bar:resume')
    const resumed = control.begin({ pid: 7, windowId: 12 })
    expect(resumed).not.toHaveProperty('refused')
    if ('end' in handle) handle.end()
    if ('end' in resumed) resumed.end()
    control.dispose()
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
    const bar = createComputerControlWindow({ readForegroundWindow: async () => null, readWindows, strings, onStop: vi.fn(), onResume: vi.fn() })
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
    const bar = createComputerControlWindow({ readForegroundWindow: async () => null, readWindows, strings, onStop: vi.fn(), onResume: vi.fn() })
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
    const bar = createComputerControlWindow({ readForegroundWindow: async () => null, readWindows, strings, onStop: vi.fn(), onResume: vi.fn() })
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
    const bar = createComputerControlWindow({ readForegroundWindow: async () => null, readWindows: async () => result(window(12)), strings, onStop: vi.fn(), onResume: vi.fn() })
    bar.show(view(11))
    await vi.advanceTimersByTimeAsync(0)
    expect(native.windows).toHaveLength(0)
    bar.hide()
  })
})
