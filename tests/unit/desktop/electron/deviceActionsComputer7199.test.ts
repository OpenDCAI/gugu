// #7199 电脑控制换成 trycua/cua 的 cua-driver:computer.<工具> 一个对一个转过去,咕咕在上面多管四件事 ——
// 不碰咕咕自己、不动人的真鼠标(整个桌面当目标的输入一律拒)、抢焦点前先问、人按停止就不再动那个 App。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComputerControlHooks, FamilyDeps } from '../../../../apps/desktop/electron/device-actions/catalog'
import { createComputerControl } from '../../../../apps/desktop/electron/device-actions/computer-control'
import { COMPUTER_TOOLS, createAppDirectory, createComputerFamily, cuaOutcome, parseTreeRows, sessionOf } from '../../../../apps/desktop/electron/device-actions/families/computer'
import { createDeviceActionGrantsStore } from '../../../../apps/desktop/electron/device-actions/grants-store'
import type { CuaToolResult } from '../../../../apps/desktop/electron/device-actions/native/cua-client'
import { NativeCallError } from '../../../../apps/desktop/electron/device-actions/native/mac-helper-client'
import { createDeviceActionsProvider } from '../../../../apps/desktop/electron/device-actions/provider'

let dir: string
let stores = 0
const GUGU_PID = 4242

const prop = (description: string) => ({ type: 'string', description })
const windowProps = {
  pid: { type: 'integer' },
  window_id: { type: 'integer' },
  element_token: prop('token'),
  target: { type: 'object' },
  delivery_mode: { type: 'string', enum: ['background', 'foreground'] },
  session: prop('run label'),
}
const TOOLS = [
  { name: 'click', description: 'Click a target pid.', input_schema: { type: 'object', properties: { ...windowProps, x: { type: 'number' }, y: { type: 'number' } }, required: [] } },
  { name: 'type_text', description: 'Insert text.', input_schema: { type: 'object', properties: { ...windowProps, text: prop('text') }, required: ['text'] } },
  { name: 'move_cursor', description: 'Move a cursor to (x, y).', input_schema: { type: 'object', properties: { ...windowProps, x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] } },
  { name: 'run_steps', description: 'Run steps.', input_schema: { type: 'object', properties: { steps: { type: 'array' }, pid: { type: 'integer' }, app: prop('app'), delivery_mode: { type: 'string' }, foreground_fallback: { type: 'boolean' }, session: prop('label') }, required: ['steps', 'session'] } },
  { name: 'launch_app', description: 'Launch a macOS app in the background.', input_schema: { type: 'object', properties: { bundle_id: prop('id'), name: prop('name'), session: prop('label') } } },
  { name: 'get_window_state', description: 'Snapshot a window.', input_schema: { type: 'object', properties: { pid: { type: 'integer' }, window_id: { type: 'integer' }, include_screenshot: { type: 'boolean' }, session: prop('label') }, required: ['pid', 'window_id'] } },
  { name: 'get_desktop_state', description: 'Capture the full display.', input_schema: { type: 'object', properties: { session: prop('label') } } },
  { name: 'list_apps', description: 'List apps.', input_schema: { type: 'object', properties: {} } },
  { name: 'list_windows', description: 'List windows.', input_schema: { type: 'object', properties: { pid: { type: 'integer' } } } },
  { name: 'kill_app', description: 'Force-terminate a process by pid.', input_schema: { type: 'object', properties: { pid: { type: 'integer' }, session: prop('label') }, required: ['pid'] } },
]

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-dacomp-'))
  fs.writeFileSync(path.join(dir, 'cua-tools.json'), JSON.stringify({ tools: TOOLS, version: '0.35.4' }))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

type CallTool = (name: string, args: Record<string, unknown>, options?: { signal?: AbortSignal }) => Promise<CuaToolResult>

function setup(options: { callTool?: CallTool; control?: ComputerControlHooks; helper?: (method: string, params?: unknown) => Promise<unknown>; platform?: NodeJS.Platform; exec?: FamilyDeps['exec'] } = {}) {
  const callTool = vi.fn(options.callTool ?? (async () => ({ content: [{ type: 'text', text: 'ok' }], structuredContent: { summary: 'done' } })))
  const stop = vi.fn()
  const helperCall = vi.fn(options.helper ?? (async (method: string) => (method === 'permissions.request' ? { status: 'granted' } : {})))
  const deps: FamilyDeps = {
    platform: options.platform ?? 'darwin',
    nativeDir: dir,
    now: () => new Date('2026-10-15T08:00:00Z'),
    homedir: () => dir,
    clipboardRead: () => '',
    clipboardWrite: vi.fn(),
    notify: vi.fn(async () => ({ shown: true })),
    openExternal: vi.fn(async () => undefined),
    trashItem: vi.fn(async () => undefined),
    jxa: vi.fn(async () => ({})),
    exec: vi.fn(options.exec ?? (async () => ({ stdout: '', stderr: '', code: 0 }))),
    macHelper: () => ({ available: () => ({ ok: true as const }), call: helperCall as never, dispose: () => undefined }),
    cua: () => ({ available: () => ({ ok: true as const }), callTool: callTool as never, stop, dispose: () => undefined }),
    selfApp: () => ({ pids: new Set([GUGU_PID]), names: new Set(['咕咕', 'com.gugu.app']) }),
    ...(options.control ? { computerControl: options.control } : {}),
  }
  const store = createDeviceActionGrantsStore(path.join(dir, `grants-${++stores}.json`))
  store.setGroup('computer', true)
  store.setGroup('screen', true)
  const p = createDeviceActionsProvider({ store, families: [createComputerFamily(dir)], deps })
  const invoke = async (action: string, args: Record<string, unknown>, caller?: { agent_user_id?: string; name?: string; task_title?: string }) => {
    const permit = await p.provider.permit(action)
    if (!permit.ok) return permit
    const pre = await p.provider.preflight?.(action, args)
    if (pre) return pre
    return p.provider.run(action, args, { callId: 'c', ...(caller ? { caller } : {}), signal: new AbortController().signal, note: () => undefined })
  }
  return { p, invoke, callTool, stop, helperCall }
}

const forwarded = (callTool: ReturnType<typeof setup>['callTool'], i = 0) => callTool.mock.calls[i] as unknown as [string, Record<string, unknown>]

describe('电脑控制:登记', () => {
  it('keeps the exact window with a snapshot token and isolates it by caller lane and PID', () => {
    const apps = createAppDirectory()
    apps.learn('a', { pid: 77, snapshot_id: 's1', window_id: 501 })
    apps.learn('b', { snapshot_id: 's1' }, { pid: 88, window_id: 601 })
    expect(apps.pidOf('a', { element_token: 's1:3' })).toBe(77)
    expect(apps.windowOf('a', { element_token: 's1:3' })).toBe(501)
    expect(apps.windowOf('b', { element_token: 's1:3' })).toBe(601)
    expect(apps.windowOf('c', { element_token: 's1:3' })).toBeUndefined()
    expect(apps.windowOf('a', { pid: 88, element_token: 's1:3' })).toBeUndefined()
    expect(apps.windowOf('a', { target: { pid: 77, window_id: 502 }, element_token: 's1:3' })).toBe(502)
  })

  it('passes an explicit or token-derived window identity to the real control boundary', async () => {
    const begin = vi.fn(() => ({ signal: new AbortController().signal, end: vi.fn() }))
    const { invoke } = setup({ control: { begin }, callTool: async (name) => name === 'get_window_state'
      ? { structuredContent: { pid: 77, snapshot_id: 's1', window_id: 501 } }
      : { structuredContent: {} } })
    await invoke('computer.get_window_state', { pid: 77, window_id: 501 }, { name: 'Agent A', task_title: 'Task one' })
    expect(begin).not.toHaveBeenCalled()
    await invoke('computer.click', { pid: 77, window_id: 501, x: 1, y: 1 }, { name: 'Agent A', task_title: 'Task one' })
    expect(begin).toHaveBeenLastCalledWith({ pid: 77, windowId: 501, callerName: 'Agent A', taskTitle: 'Task one' })
    await invoke('computer.click', { element_token: 's1:3', x: 1, y: 1 }, { name: 'Agent A' })
    expect(begin).toHaveBeenLastCalledWith({ pid: 77, windowId: 501, callerName: 'Agent A' })
    await invoke('computer.click', { target: { pid: 77, window_id: 502 }, x: 1, y: 1 }, { name: 'Agent A' })
    expect(begin).toHaveBeenLastCalledWith({ pid: 77, windowId: 502, callerName: 'Agent A' })
  })

  it('learns a launched App name only in its caller lane and preserves explicit target precedence', () => {
    const apps = createAppDirectory()
    apps.learn('a', { pid: 77, app_name: 'Calculator' }, { app: 'com.apple.calculator' })
    expect(apps.pidOf('a', { app: 'calculator' })).toBe(77)
    expect(apps.pidOf('a', { app: 'com.apple.calculator' })).toBe(77)
    expect(apps.pidOf('b', { app: 'Calculator' })).toBeUndefined()
    expect(apps.pidOf('a', { app: 'Calculator', pid: 88 })).toBe(88)
    apps.learn('a', { pid: 0, app_name: 'Not running' })
    expect(apps.pidOf('a', { app: 'Not running' })).toBeUndefined()
  })

  it('keeps protected-host refusal after resolving an App alias learned from a read-only result', async () => {
    const { invoke, callTool } = setup({ callTool: async () => ({ structuredContent: { windows: [{ pid: GUGU_PID, app_name: 'Host alias' }] } }) })
    await invoke('computer.list_windows', {})
    callTool.mockClear()
    expect(await invoke('computer.click', { app: 'Host alias', role: 'button', name: 'Open' })).toMatchObject({ code: 'invalid_args', message: expect.stringContaining('咕咕 itself') })
    expect(callTool).not.toHaveBeenCalled()
  })

  it('does not let cold launch bypass a person’s existing global Stop', async () => {
    const control = createComputerControl({ view: { show: vi.fn(), hide: vi.fn() } })
    const prior = control.begin({})
    control.stop()
    if ('end' in prior) prior.end()
    const { invoke, callTool } = setup({ control })
    expect(await invoke('computer.launch_app', { name: 'Calculator' })).toMatchObject({ code: 'revoked' })
    expect(callTool).not.toHaveBeenCalled()
    control.dispose()
  })

  it('keeps a cold launch cancellable while its window attachment is deferred', async () => {
    const show = vi.fn()
    const control = createComputerControl({ view: { show, hide: vi.fn() } })
    const prior = control.begin({})
    const { invoke } = setup({ control, callTool: async () => {
      control.stop()
      return { structuredContent: { pid: 77, name: 'Calculator' } }
    } })
    expect(await invoke('computer.launch_app', { name: 'Calculator' })).toMatchObject({ code: 'revoked' })
    expect(show.mock.calls.filter(([view]) => view.app?.pid === 77)).toHaveLength(0)
    if ('end' in prior) prior.end()
    control.dispose()
  })

  it('resolves app-name input against live windows when the launched process has changed', async () => {
    const begin = vi.fn(() => ({ signal: new AbortController().signal, ready: Promise.resolve(true), end: vi.fn() }))
    const { invoke } = setup({ control: { begin }, callTool: async name => name === 'launch_app'
      ? { structuredContent: { pid: 77, name: 'Calculator' } }
      : { structuredContent: { windows: [{ pid: 88, window_id: 6, app_name: 'Calculator', is_on_screen: true, layer: 0, bounds: { x: 0, y: 0, width: 300, height: 400 } }] } } })
    await invoke('computer.launch_app', { name: 'Calculator' })
    expect(await invoke('computer.click', { app: 'Calculator', role: 'button', name: '1' })).toHaveProperty('ok', true)
    expect(begin).toHaveBeenLastCalledWith(expect.objectContaining({ pid: 88, windowId: 6 }))
  })

  it.each([
    ['computer.list_apps', {}],
    ['computer.list_windows', {}],
    ['computer.list_windows', { pid: 77 }],
  ] as const)('does not begin activity for read-only %s %j', async (action, args) => {
    const begin = vi.fn(() => ({ signal: new AbortController().signal, end: vi.fn() }))
    const { invoke, callTool } = setup({ control: { begin } })
    expect(await invoke(action, args)).toMatchObject({ ok: true })
    expect(begin).not.toHaveBeenCalled()
    expect(callTool).toHaveBeenCalledExactlyOnceWith(action.slice('computer.'.length), args, expect.anything())
  })

  it('keeps activity and its end handle for an act call', async () => {
    const end = vi.fn()
    const begin = vi.fn(() => ({ signal: new AbortController().signal, end }))
    const { invoke } = setup({ control: { begin } })
    expect(await invoke('computer.click', { pid: 77, window_id: 5, x: 10, y: 20 })).toMatchObject({ ok: true })
    expect(begin).toHaveBeenCalledExactlyOnceWith({ pid: 77, windowId: 5 })
    expect(end).toHaveBeenCalledOnce()
  })

  it('forwards the trusted execution budget through the provider and computer family without putting it in tool args', async () => {
    const { p, callTool } = setup()
    let left = 60_000
    const remainingMs = () => left
    await p.provider.run('computer.run_steps', { pid: 77, steps: [{ click: { role: 'button', name: '1' } }] }, {
      callId: 'budget', signal: new AbortController().signal, note: () => undefined, remainingMs,
    })
    const [, args, options] = callTool.mock.calls[0] as unknown as [string, Record<string, unknown>, { remainingMs?: () => number; timeoutMs: number }]
    expect(options.remainingMs).toBe(remainingMs)
    left = 7_000
    expect(options.remainingMs?.()).toBe(7_000)
    expect(options.timeoutMs).toBe(75_000)
    expect(args).not.toHaveProperty('remainingMs')
  })

  it('computer.<cua 工具名>,说明照 cua 自己的再补咕咕的规矩;参数去掉 session(咕咕按调用方分)', () => {
    const { p } = setup()
    const names = p.capability()!.actions.filter((a) => a.group === 'computer').map((a) => a.name)
    expect(names).toEqual(COMPUTER_TOOLS.map((t) => `computer.${t}`))
    expect(names).not.toContain('computer.run_script')
    expect(names).not.toContain('computer.set_agent_cursor_enabled')
    const click = p.capability()!.actions.find((a) => a.name === 'computer.click')!
    expect(click.description).toContain('Click a target pid.')
    expect(click.description).toContain('real pointer')
    expect(Object.keys((click.input_schema as { properties: object }).properties)).not.toContain('session')
    const steps = p.capability()!.actions.find((a) => a.name === 'computer.run_steps')!
    expect((steps.input_schema as { required: string[] }).required).toEqual(['steps'])
    expect(p.groups().find((g) => g.id === 'computer')!.platforms).toEqual(['darwin', 'win32'])
  })
})

describe('电脑控制:咕咕的规矩', () => {
  it('不碰咕咕自己:pid / target.pid / bundle_id / App 名 / run_steps 的 app 与每一步', async () => {
    const { invoke, callTool } = setup()
    const refused = [
      ['computer.click', { pid: GUGU_PID, window_id: 1, x: 1, y: 1 }],
      ['computer.click', { target: { kind: 'window', pid: GUGU_PID, window_id: 1 }, x: 1, y: 1 }],
      ['computer.launch_app', { bundle_id: 'com.gugu.app' }],
      ['computer.launch_app', { name: '咕咕' }],
      ['computer.get_window_state', { pid: GUGU_PID, window_id: 3 }],
      ['computer.run_steps', { app: '咕咕', steps: [{ click: { role: 'button', name: '连接' } }] }],
      ['computer.run_steps', { pid: GUGU_PID, steps: [{ click: { window_id: 1, x: 1, y: 1 } }] }],
      ['computer.run_steps', { pid: 77, steps: [{ click: { window_id: 1, x: 1, y: 1 } }], observe: { pid: GUGU_PID, window_id: 3 } }],
      ['computer.run_steps', { steps: [{ tool: 'click', args: { pid: GUGU_PID, window_id: 1, x: 1, y: 1 } }] }],
    ] as const
    for (const [action, args] of refused) {
      const result = await invoke(action, { ...args })
      expect(result, action).toMatchObject({ ok: false, code: 'invalid_args', message: expect.stringContaining('咕咕 itself') })
      expect(result, action).toMatchObject({ message: expect.stringContaining("For webpages in this session's browser tabs, use browser_* tools.") })
    }
    expect(callTool).not.toHaveBeenCalled()
  })

  it('保留显式桌面目标限制;裸输入与批次原样交给驱动,不依赖小条附着', async () => {
    const { invoke, callTool } = setup()
    for (const [action, args] of [
      ['computer.click', { target: { kind: 'desktop', display_id: 'primary' }, x: 10, y: 10 }],
      ['computer.move_cursor', { x: 1, y: 1, target: { kind: 'desktop' } }],
    ] as const) {
      expect(await invoke(action, { ...args }), `${action} ${JSON.stringify(args)}`).toMatchObject({ ok: false, code: 'invalid_args' })
    }
    expect(callTool).not.toHaveBeenCalled()
    expect(await invoke('computer.click', { x: 10, y: 10 })).toMatchObject({ ok: true })
    expect(await invoke('computer.type_text', { text: 'hi' })).toMatchObject({ ok: true })
    expect(await invoke('computer.run_steps', { steps: [{ click: { window: '设置', role: 'button', name: 'OK' } }] })).toMatchObject({ ok: true })
    expect(await invoke('computer.move_cursor', { x: 100, y: 120 })).toMatchObject({ ok: true })
    expect(await invoke('computer.get_desktop_state', {})).toMatchObject({ ok: true })
    expect(await invoke('computer.click', { pid: 77, window_id: 5, element_token: 's1:5' })).toMatchObject({ ok: true })
    expect(await invoke('computer.run_steps', { app: 'Calculator', steps: [{ click: { role: 'button', name: '7' } }] })).toMatchObject({ ok: true })
    expect(callTool.mock.calls.map((c) => c[0])).toEqual(['click', 'type_text', 'run_steps', 'move_cursor', 'get_desktop_state', 'click', 'run_steps'])
  })

  it('抢焦点前先问:foreground 投递 / foreground_fallback → needs_confirmation;带 confirmed 才发,confirmed 不转给 cua', async () => {
    const { invoke, callTool } = setup()
    expect(await invoke('computer.click', { pid: 77, window_id: 5, x: 3, y: 4, delivery_mode: 'foreground' })).toMatchObject({ ok: false, code: 'needs_confirmation', confirm: { question: expect.stringContaining('切到前台') } })
    expect(await invoke('computer.run_steps', { pid: 77, foreground_fallback: true, steps: [{ click: { role: 'button', name: 'Go' } }] })).toMatchObject({ code: 'needs_confirmation' })
    expect(await invoke('computer.run_steps', { pid: 77, steps: [{ tool: 'drag', args: { delivery_mode: 'foreground', from_x: 1, from_y: 1, to_x: 2, to_y: 2 } }] })).toMatchObject({ code: 'needs_confirmation' })
    expect(callTool).not.toHaveBeenCalled()
    expect(await invoke('computer.click', { pid: 77, window_id: 5, x: 3, y: 4, delivery_mode: 'foreground', confirmed: true })).toMatchObject({ ok: true })
    expect(forwarded(callTool)[1]).not.toHaveProperty('confirmed')
  })

  it('Windows 上打开 App 先问(普通启动的 App 可能自己跳到前台,cua-driver 拦不住);带 start_minimized 不问;Mac 上照常在后台打开', async () => {
    const win = setup({ platform: 'win32' })
    expect(await win.invoke('computer.launch_app', { path: 'C:\\Windows\\System32\\charmap.exe' })).toMatchObject({
      ok: false,
      code: 'needs_confirmation',
      confirm: { question: expect.stringContaining('charmap.exe') },
    })
    expect(await win.invoke('computer.launch_app', { name: 'Notepad' })).toMatchObject({ code: 'needs_confirmation', confirm: { question: expect.stringContaining('Notepad') } })
    expect(win.callTool).not.toHaveBeenCalled()
    expect(await win.invoke('computer.launch_app', { name: 'Notepad', confirmed: true })).toMatchObject({ ok: true })
    expect(forwarded(win.callTool)[0]).toBe('launch_app')
    expect(forwarded(win.callTool)[1]).not.toHaveProperty('confirmed')
    expect(await win.invoke('computer.launch_app', { name: 'Notepad', start_minimized: true })).toMatchObject({ ok: true })
    // 打开咕咕自己照旧直接拒,不先问。
    expect(await win.invoke('computer.launch_app', { name: '咕咕' })).toMatchObject({ ok: false, code: 'invalid_args' })

    const mac = setup({ platform: 'darwin' })
    expect(await mac.invoke('computer.launch_app', { bundle_id: 'com.apple.calculator' })).toMatchObject({ ok: true })
  })

  it('强制退出、切到前台每次都先问,问句说清是谁', async () => {
    const { invoke, callTool } = setup()
    expect(await invoke('computer.kill_app', { pid: 99 })).toMatchObject({ ok: false, code: 'needs_confirmation', confirm: { question: expect.stringContaining('99') } })
    expect(callTool).not.toHaveBeenCalled()
  })

  it('会话按调用方分:同一个调用方同一个会话名,两个调用方不同;agent 自己给的 session 不算数', async () => {
    const { invoke, callTool } = setup()
    await invoke('computer.click', { pid: 77, window_id: 5, element_token: 's1:5', session: 'hijack' }, { agent_user_id: 'agent-a', name: '云端助理' })
    await invoke('computer.click', { pid: 77, window_id: 5, element_token: 's1:5' }, { agent_user_id: 'agent-b' })
    await invoke('computer.list_apps', {}, { agent_user_id: 'agent-a' })
    const a = forwarded(callTool, 0)[1].session
    const b = forwarded(callTool, 1)[1].session
    expect(a).toBe(sessionOf({ caller: { agent_user_id: 'agent-a' } }))
    expect(a).toMatch(/^gugu-[0-9a-f]{10}$/)
    expect(b).not.toBe(a)
    // 清单里没有 session 参数的工具就不塞。
    expect(forwarded(callTool, 2)[1]).not.toHaveProperty('session')
  })
})

describe('电脑控制:人接管那个 App(停止只停它)', () => {
  const NAMES: Record<number, string> = { 77: '计算器', 88: '备忘录' }
  function withControl(
    callTool: (name: string, args: Record<string, unknown>, opts: { signal?: AbortSignal }) => Promise<CuaToolResult>,
    extra: { platform?: NodeJS.Platform; exec?: FamilyDeps['exec']; windows?: Record<number, Record<string, unknown>> } = {},
  ) {
    const views: string[] = []
    const control = createComputerControl({
      view: { show: (v) => { views.push(`${v.state}:${v.app ? (v.app.name ?? '?') : '-'}`) }, hide: () => { views.push('hide') } },
    })
    const env = setup({
      control,
      ...(extra.platform ? { platform: extra.platform } : {}),
      ...(extra.exec ? { exec: extra.exec } : {}),
      callTool: (async (name: string, args: Record<string, unknown>, opts: { signal?: AbortSignal }) => {
        if (name === 'list_windows' && typeof args.pid === 'number') {
          const w = extra.windows?.[args.pid] ?? (NAMES[args.pid] ? { app_name: NAMES[args.pid] } : null)
          return { content: [], structuredContent: { windows: w ? [{ pid: args.pid, window_id: 5, ...w }] : [] } }
        }
        return callTool(name, args, opts)
      }) as never,
    })
    return { ...env, control, views }
  }
  const okResult = async (): Promise<CuaToolResult> => ({ content: [{ type: 'text', text: 'ok' }], structuredContent: { summary: 'done' } })

  it('小条写 agent 正在操作的 App 名;element_token(不带 pid)靠它所在的快照认回是哪个 App', async () => {
    const { invoke, views } = withControl(async (name, args) =>
      name === 'get_window_state' ? { content: [], structuredContent: { pid: args.pid, snapshot_id: 's7', app_name: '计算器', tree_markdown: '' } }
        // list_apps 给的是 App 包名(英文),小条写窗口上的名字。
        : name === 'list_apps' ? { content: [], structuredContent: { apps: [{ pid: 77, name: 'Calculator' }, { pid: 88, name: 'Notes' }] } }
          : okResult())
    await invoke('computer.list_apps', {}, { name: '云端助理' })
    await invoke('computer.get_window_state', { pid: 77, window_id: 5 }, { name: '云端助理' })
    expect(views).toEqual([])
    await invoke('computer.click', { element_token: 's7:3' }, { name: '云端助理' })
    expect(views.at(-1)).toBe('driving:计算器')
    await invoke('computer.list_apps', {}, { name: '云端助理' })
    expect(views.at(-1)).toBe('driving:计算器')
    // 另一个 App 亮起来,再用计算器快照里的 element_token 点:认回计算器。
    await invoke('computer.click', { pid: 88, window_id: 6, element_token: 'x1:1' }, { name: '云端助理' })
    expect(views.at(-1)).toBe('driving:备忘录')
    await invoke('computer.click', { element_token: 's7:3' }, { name: '云端助理' })
    expect(views.at(-1)).toBe('driving:计算器')
  })

  it('Windows:小条写 exe 版本信息里的 FileDescription(系统语言名);读不到退回窗口标题,再读不到才写文件名', async () => {
    const exec = vi.fn(async (_file: string, args: readonly string[]) => ({
      stdout: args.join(' ').includes('-Id 31 ') ? '\uFEFF字符映射表\r\n' : '',
      stderr: '',
      code: 0,
    }))
    const { invoke, views } = withControl(okResult, {
      platform: 'win32',
      exec: exec as never,
      windows: { 31: { app_name: 'charmap.exe', title: '字符映射表' }, 32: { app_name: 'notepad.exe', title: '无标题 - 记事本' }, 33: { app_name: 'tool.exe', title: '' } },
    })
    await invoke('computer.click', { pid: 31, window_id: 5, x: 1, y: 1 })
    expect(views.at(-1)).toBe('driving:字符映射表')
    expect(exec).toHaveBeenCalledWith('powershell.exe', expect.arrayContaining(['-Command']), expect.anything())
    await invoke('computer.click', { pid: 32, window_id: 5, x: 1, y: 1 })
    expect(views.at(-1)).toBe('driving:无标题 - 记事本')
    await invoke('computer.click', { pid: 33, window_id: 5, x: 1, y: 1 })
    expect(views.at(-1)).toBe('driving:tool.exe')
    // 每个进程只读一次。
    await invoke('computer.click', { pid: 31, window_id: 5, x: 1, y: 1 })
    expect(exec.mock.calls.filter(([, a]) => a.join(' ').includes('-Id 31 '))).toHaveLength(1)
  })

  it.each(['same-app windows', 'mixed apps', 'known and unresolved'] as const)('cannot bypass a paused App with a %s batch, even when no indicator attaches', async shape => {
    const control = createComputerControl({ view: { show: vi.fn(async () => false), hide: vi.fn() } })
    const prior = control.begin({ pid: 77, windowId: 5, appName: 'Calculator' })
    control.stop()
    if ('end' in prior) prior.end()
    const { invoke, callTool } = setup({ control, callTool: okResult })
    const args = shape === 'same-app windows'
      ? { pid: 77, steps: [5, 6].map(window_id => ({ tool: 'click', args: { window_id, x: 1, y: 2 } })) }
      : shape === 'mixed apps'
        ? { steps: [88, 77].map(pid => ({ click: { pid, window_id: 5, x: 1, y: 2 } })) }
        : { steps: [{ click: { x: 1, y: 2 } }, { click: { pid: 77, window_id: 5, x: 1, y: 2 } }] }
    expect(await invoke('computer.run_steps', args)).toMatchObject({ code: 'revoked' })
    expect(callTool.mock.calls.filter(([name]) => name === 'run_steps')).toHaveLength(0)
    expect(control.stoppedFor(77)).not.toBeNull()
    control.resume()
    expect(await invoke('computer.run_steps', args)).toHaveProperty('ok', true)
    expect(callTool.mock.calls.filter(([name]) => name === 'run_steps')).toHaveLength(1)
    expect(callTool).toHaveBeenLastCalledWith('run_steps', expect.objectContaining(args), expect.anything())
    control.dispose()
  })

  it('forwards a participating App Stop to an already running mixed-App native batch', async () => {
    let running = false
    const control = createComputerControl({ view: { show: vi.fn(async () => false), hide: vi.fn() } })
    const { invoke, callTool } = setup({ control, callTool: async (name, _args, opts) => {
      if (name !== 'run_steps') return okResult()
      return new Promise<CuaToolResult>((_, reject) => {
        opts?.signal?.addEventListener('abort', () => reject(new NativeCallError('execution_failed', 'cancelled')), { once: true })
        running = true
      })
    } })
    const pending = invoke('computer.run_steps', { steps: [77, 88].map(pid => ({ click: { pid, window_id: 5, x: 1, y: 2 } })) })
    await vi.waitFor(() => expect(running).toBe(true))
    const other = control.begin({ pid: 88, windowId: 5, appName: 'Notes' })
    control.stop()
    expect(await pending).toMatchObject({ code: 'revoked', message: expect.stringContaining('Notes') })
    expect(callTool.mock.calls.filter(([name]) => name === 'run_steps')).toHaveLength(1)
    if ('end' in other) other.end()
    control.dispose()
  })

  it('preserves a known App Stop during a lookup outage without using its cached PID as an input target', async () => {
    let outage = false
    const control = createComputerControl({ view: { show: vi.fn(async () => false), hide: vi.fn() } })
    const { invoke, callTool } = setup({ control, callTool: async name => {
      if (name === 'list_apps' && !outage) return { structuredContent: { apps: [{ pid: 77, name: 'Calculator' }] } }
      if (name === 'list_windows' || name === 'list_apps') throw new NativeCallError('execution_failed', 'lookup unavailable')
      return okResult()
    } })
    await invoke('computer.list_apps', {})
    const prior = control.begin({ pid: 77, windowId: 5, appName: 'Calculator' })
    control.stop()
    if ('end' in prior) prior.end()
    outage = true
    expect(await invoke('computer.click', { app: 'Calculator', role: 'button', name: '1' })).toMatchObject({ code: 'revoked' })
    expect(callTool.mock.calls.filter(([name]) => name === 'click')).toHaveLength(0)
    control.resume()
    expect(await invoke('computer.click', { app: 'Calculator', role: 'button', name: '2' })).toHaveProperty('ok', true)
    expect(callTool).toHaveBeenLastCalledWith('click', expect.objectContaining({ app: 'Calculator', role: 'button', name: '2' }), expect.anything())
    expect((forwarded(callTool, callTool.mock.calls.length - 1))[1]).not.toHaveProperty('pid')
    control.dispose()
  })

  it('rechecks a named App pause against live process identity when window lookup times out', async () => {
    let livePid = 77
    const control = createComputerControl({ view: { show: vi.fn(async () => false), hide: vi.fn() } })
    const { invoke, callTool } = setup({ control, callTool: async (name, args) => {
      if (name === 'list_apps') return { structuredContent: { apps: [{ pid: livePid, name: 'Calculator', bundle_id: 'com.apple.calculator' }] } }
      if (name === 'list_windows' && args.app) throw new NativeCallError('execution_failed', 'window query timed out')
      if (name === 'list_windows') return { structuredContent: { windows: [] } }
      return okResult()
    } })
    await invoke('computer.list_apps', {}) // Learn the old PID first.
    const prior = control.begin({ pid: 77, windowId: 5, appName: 'Calculator' })
    control.stop()
    if ('end' in prior) prior.end()
    expect(await invoke('computer.click', { app: 'Calculator', role: 'button', name: '1' })).toMatchObject({ code: 'revoked' })
    expect(callTool.mock.calls.filter(([name]) => name === 'click')).toHaveLength(0)
    livePid = 88 // The app restarted; do not use the stale cached PID.
    expect(await invoke('computer.click', { app: 'Calculator', role: 'button', name: '2' })).toHaveProperty('ok', true)
    expect(callTool.mock.calls.filter(([name]) => name === 'click')).toHaveLength(1)
    expect(control.stoppedFor(77)).not.toBeNull()
    expect(control.stoppedFor(88)).toBeNull()
    control.dispose()
  })

  it('人按停止:计算器上在途的那一下回 revoked(❌ 当成执行失败),之后不再发给 cua;备忘录照常;「让它继续」后恢复', async () => {
    let inFlight: (() => void) | null = null
    const { invoke, callTool, control } = withControl((name, args, opts) => {
      if (name === 'click' && args.pid === 77) {
        return new Promise((_, reject) => {
          inFlight = () => undefined
          opts.signal?.addEventListener('abort', () => reject(new NativeCallError('execution_failed', '已取消')), { once: true })
        })
      }
      return okResult()
    })
    const pending = invoke('computer.click', { pid: 77, window_id: 5, element_token: 's1:5' }, { name: '云端助理' })
    await vi.waitFor(() => expect(inFlight).not.toBeNull())
    control.stop()
    expect(await pending).toMatchObject({ ok: false, code: 'revoked', message: expect.stringContaining('"计算器"') })

    const before = callTool.mock.calls.filter(([n]) => n === 'click').length
    expect(await invoke('computer.click', { pid: 77, window_id: 5, element_token: 's1:6' })).toMatchObject({ ok: false, code: 'revoked' })
    expect(callTool.mock.calls.filter(([n]) => n === 'click')).toHaveLength(before)

    expect(await invoke('computer.click', { pid: 88, window_id: 6, element_token: 's2:1' })).toMatchObject({ ok: true })
    // 小条此刻亮的是备忘录;agent 再去碰计算器,暂停的那条重新亮出来,人点「让它继续」。
    expect(await invoke('computer.type_text', { pid: 77, window_id: 5, text: '1' })).toMatchObject({ code: 'revoked' })
    control.resume()
    expect(await invoke('computer.type_text', { pid: 77, window_id: 5, text: '1' })).toMatchObject({ ok: true })
  })
})

describe('电脑控制:结果', () => {
  it('图片进 pictures,结构化内容进 data;权限问题 → os_permission;画不了 agent 鼠标 → unsupported', () => {
    expect(cuaOutcome('computer.get_window_state', { content: [{ type: 'text', text: 'tree' }, { type: 'image', mimeType: 'image/png', data: 'AAAA' }], structuredContent: { snapshot_id: 's1', tree_markdown: '- [0] AXWindow' } }))
      .toEqual({ ok: true, data: { snapshot_id: 's1', tree_markdown: '- [0] AXWindow', text: 'tree', pictures: [{ label: 'computer.get_window_state screenshot', mimeType: 'image/png', data: 'AAAA' }] } })
    expect(cuaOutcome('x', { isError: true, content: [{ type: 'text', text: 'Screen Recording permission not granted' }] })).toMatchObject({ ok: false, code: 'os_permission', message: expect.stringContaining('Screen Recording') })
    expect(cuaOutcome('x', { isError: true, content: [{ type: 'text', text: 'Accessibility is not trusted for this process' }] })).toMatchObject({ code: 'os_permission', message: expect.stringContaining('Accessibility') })
    expect(cuaOutcome('x', { isError: true, structuredContent: { refusal: { code: 'facility_unavailable', message: 'overlay unavailable' } } })).toMatchObject({ code: 'unsupported' })
    expect(cuaOutcome('x', { isError: true, content: [{ type: 'text', text: 'ambiguous_window_target' }] })).toMatchObject({ code: 'execution_failed', message: 'x: ambiguous_window_target' })
  })

  it('turns only the native missing-window click error into recovery steps after dispatch', async () => {
    const nativeMessage = 'click: x,y given with no pid/window_id, but scope is "window". Screen-absolute clicks require desktop scope. Pass scope="desktop" (and use get_desktop_state with scope="desktop" to read true screen pixels) first.'
    const native = { isError: true, content: [{ type: 'text' as const, text: nativeMessage }], structuredContent: { code: 'desktop_scope_disabled', scope: 'window', suggestion: 'pass scope="desktop"' } }
    const { invoke, callTool } = setup({ callTool: async () => native })
    expect(await invoke('computer.click', { x: 1, y: 2 })).toEqual({ ok: false, code: 'execution_failed', message: 'computer.click: Clicking needs a target window. First use computer.launch_app or computer.list_windows to get the target app and window, then retry computer.click with pid and window_id, or an element_token from computer.get_window_state.' })
    expect(callTool).toHaveBeenCalledExactlyOnceWith('click', expect.objectContaining({ x: 1, y: 2 }), expect.anything())
    // No rewrite for another tool, a different native error, or a successful call.
    expect(cuaOutcome('computer.type_text', native)).toMatchObject({ message: `computer.type_text: ${nativeMessage}` })
    expect(cuaOutcome('computer.click', { ...native, structuredContent: { code: 'invalid_arguments' } })).toMatchObject({ message: `computer.click: ${nativeMessage}` })
    expect(cuaOutcome('computer.click', { structuredContent: { code: 'desktop_scope_disabled', clicked: true } })).toEqual({ ok: true, data: { code: 'desktop_scope_disabled', clicked: true } })
    expect(cuaOutcome('computer.click', { ...native, content: [{ type: 'text', text: 'Accessibility is not trusted for this process' }] })).toHaveProperty('code', 'os_permission')
  })

  it('读 get_window_state 的树:编号行、静态文字、id', () => {
    const rows = parseTreeRows('- [0] AXWindow "计算器" [id=main actions=[raise]]\n    - AXStaticText = "‎9,240"\n    - [5] AXButton (7) [id=Seven actions=[press]]')
    expect(rows).toEqual([
      { index: 0, role: 'AXWindow', label: '计算器', value: '', identifier: 'main' },
      { index: null, role: 'AXStaticText', label: '', value: '9,240', identifier: null },
      { index: 5, role: 'AXButton', label: '7', value: '', identifier: 'Seven' },
    ])
  })
})

describe('屏幕(Mac,走 cua 读前台窗口)', () => {
  const desk: CallTool = async (name) => {
    if (name === 'list_apps') return { structuredContent: { apps: [{ name: 'Calculator', bundle_id: 'com.apple.calculator', pid: 77, active: true }, { name: 'Chrome', pid: 5, active: false }] } }
    if (name === 'list_windows') return { structuredContent: { windows: [{ window_id: 9, title: '计算器', layer: 0, is_on_screen: true }] } }
    if (name === 'get_window_state') return { structuredContent: { snapshot_id: 's3', tree_markdown: '- [0] AXWindow "计算器"\n  - AXStaticText = "9,240"\n  - [5] AXButton (7) [id=Seven]\n  - [6] AXButton (8) [id=Eight]' } }
    return { content: [] }
  }

  it('screen.get:前台 App、窗口标题、文字;不截图', async () => {
    const { invoke, callTool } = setup({ callTool: desk })
    expect(await invoke('screen.get', {})).toMatchObject({ ok: true, data: { app_name: 'Calculator', bundle_id: 'com.apple.calculator', window_title: '计算器', texts: ['9,240'], interactive_elements: 3, ax_coverage: 'full' } })
    expect(callTool).toHaveBeenCalledWith('get_window_state', expect.objectContaining({ pid: 77, window_id: 9, include_screenshot: false }), expect.anything())
  })

  it('screen.elements.find:按文字找,给出 computer.click 认的 element_token', async () => {
    const { invoke } = setup({ callTool: desk })
    expect(await invoke('screen.elements.find', { query: 'seven' })).toMatchObject({ ok: true, data: { pid: 77, window_id: 9, elements: [{ role: 'AXButton', label: '7', identifier: 'Seven', element_token: 's3:5' }], total_matches: 1 } })
  })

  it('前台是咕咕自己:不读', async () => {
    const { invoke } = setup({ callTool: async (name) => (name === 'list_apps' ? { structuredContent: { apps: [{ name: '咕咕', pid: GUGU_PID, active: true }] } } : { content: [] }) })
    expect(await invoke('screen.get', {})).toMatchObject({ ok: false, code: 'invalid_args', message: expect.stringContaining('咕咕 itself') })
  })
})

describe('连接「电脑控制」', () => {
  it('Mac:要辅助功能和屏幕录制,要到了把 cua-driver 重起一次(它按进程缓存授权)', async () => {
    const { p, helperCall, stop } = setup()
    expect(await p.connect('computer')).toEqual({ ok: true })
    expect(helperCall.mock.calls.map((c) => (c[1] as { kind: string }).kind)).toEqual(['accessibility', 'screen'])
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('Mac:屏幕录制没给 → os_permission,❌ 记成连上', async () => {
    const { p } = setup({ helper: async (_m, params) => ({ status: (params as { kind: string }).kind === 'screen' ? 'denied' : 'granted' }) })
    expect(await p.connect('computer')).toMatchObject({ ok: false, code: 'os_permission' })
  })

  it('Windows:没有系统授权这一关,有 cua-driver 就连上', async () => {
    const { p, helperCall } = setup({ platform: 'win32' })
    expect(await p.connect('computer')).toEqual({ ok: true })
    expect(helperCall).not.toHaveBeenCalled()
  })
})
