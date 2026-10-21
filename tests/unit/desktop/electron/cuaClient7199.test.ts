// #7199 cua-driver 的嵌入:咕咕直接起 `serve --embedded`(守护进程,授权记在咕咕名下、画 agent 鼠标)和 `mcp --embedded`(代理);
// 环境只给白名单(❌ 把咕咕的 key 交出去、上报使用数据、查更新、写 ~/.cua-driver);超时 / 取消只撤这一个调用;
// 急停把两个进程一起关、在途的调用随之失败,下一次再重起。
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCuaClient, cuaEnvironment, cuaSocketPath } from '../../../../apps/desktop/electron/device-actions/native/cua-client'
import * as daemonLeases from '../../../../apps/desktop/electron/device-actions/native/cua-daemon-lease'
import { NativeCallError } from '../../../../apps/desktop/electron/device-actions/native/mac-helper-client'
import { createDeviceActionHost } from '@gugu/core/cloud/deviceActionHost'
import { DEVICE_ACTION_RESULT_EVENT } from '@gugu/core/shared/deviceActions'

class FakeProc extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  exitCode: number | null = null
  signalCode: string | null = null
  killed = false
  kill(signal = 'SIGTERM') {
    if (this.killed) return true
    this.killed = true
    this.signalCode = signal
    setImmediate(() => this.emit('exit', null, signal))
    return true
  }
}

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-cua-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(dir, { recursive: true, force: true })
})

/** 假的 cua-driver:serve 建好 socket 文件;mcp 照 JSON-RPC 回话,tools/call 交给 answer(回 undefined = 一直不回)。 */
function fakeDriver(answer: (name: string, args: Record<string, unknown>) => unknown) {
  const spawned: Array<{ args: readonly string[]; env: NodeJS.ProcessEnv; proc: FakeProc }> = []
  const received: Array<Record<string, unknown>> = []
  const spawn = (_command: string, args: readonly string[], options: { env: NodeJS.ProcessEnv }) => {
    const proc = new FakeProc()
    spawned.push({ args, env: options.env, proc })
    if (args[0] === 'serve') {
      const socket = args[args.indexOf('--socket') + 1]!
      setTimeout(() => fs.writeFileSync(socket, ''), 20)
    } else {
      let buf = ''
      proc.stdin.on('data', (chunk: Buffer) => {
        buf += chunk.toString()
        let i
        while ((i = buf.indexOf('\n')) >= 0) {
          const msg = JSON.parse(buf.slice(0, i)) as { id?: number; method: string; params?: { name: string; arguments: Record<string, unknown> } }
          buf = buf.slice(i + 1)
          received.push(msg as unknown as Record<string, unknown>)
          if (msg.method === 'initialize') proc.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { serverInfo: { name: 'cua-driver' } } })}\n`)
          if (msg.method === 'tools/call') {
            const result = answer(msg.params!.name, msg.params!.arguments)
            if (result !== undefined) proc.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n`)
          }
        }
      })
    }
    return proc as never
  }
  return { spawn, spawned, received }
}

const binary = () => {
  const file = path.join(dir, 'cua-driver')
  fs.writeFileSync(file, '')
  return file
}

describe('环境', () => {
  it('only forwards an explicitly configured official CUA_LOG filter', () => {
    expect(cuaEnvironment({ home: '/gugu', source: {} })).not.toHaveProperty('CUA_LOG')
    expect(cuaEnvironment({ home: '/gugu', source: { CUA_LOG: 'cua_driver_core::tool=info' } }).CUA_LOG).toBe('cua_driver_core::tool=info')
  })
  it('只给系统要的几样 + cua 自己的开关:嵌入、standard、不上报、不查更新、数据目录挪进咕咕', () => {
    const env = cuaEnvironment({ home: '/gugu/cua-driver', hostBundleId: 'com.gugu.app', source: { PATH: '/bin', HOME: '/Users/a', OPENAI_API_KEY: 'sk-secret', GUGU_SUPABASE_ANON_KEY: 'x', CUA_DRIVER_PERCEPTION_CATALOG: '/agpl' } })
    expect(env).toEqual({
      PATH: '/bin',
      HOME: '/Users/a',
      CUA_DRIVER_EMBEDDED: '1',
      CUA_DRIVER_PERMISSION_MODE: 'standard',
      CUA_DRIVER_RS_TELEMETRY_ENABLED: 'false',
      CUA_DRIVER_RS_UPDATE_CHECK: 'false',
      CUA_DRIVER_RS_HOME: '/gugu/cua-driver',
      CUA_DRIVER_HOST_BUNDLE_ID: 'com.gugu.app',
    })
  })

  it('私有通道:Unix 是临时目录里的 socket(macOS 路径上限 104 字节),Windows 是命名管道', () => {
    expect(cuaSocketPath('win32', 123)).toBe('\\\\.\\pipe\\gugu-cua-123')
    expect(cuaSocketPath('darwin', 123)).toBe(path.join(os.tmpdir(), 'gugu-cua-123.sock'))
    expect(Buffer.byteLength(cuaSocketPath('darwin', 99999))).toBeLessThan(104)
  })
})

describe('起、调、停', () => {
  it('returns executed steps before the host deadline when the closing capture crosses the remaining budget', async () => {
    const close = vi.fn()
    const calls: string[] = []
    const steps = Array.from({ length: 7 }, (_, index) => ({ index, ok: true, target: { window: { pid: 1, window_id: 2 } } }))
    vi.spyOn(daemonLeases, 'openCuaDaemonLease').mockResolvedValue({ close, call: async name => {
      calls.push(name)
      if (name === 'run_steps') {
        await new Promise(resolve => setTimeout(resolve, 53_000))
        return { content: [], structuredContent: { ok: true, executed: 7, total: 7, failed_step: null, steps, observation: { ok: false } } }
      }
      if (name === 'get_window_state') return new Promise(() => undefined)
      return { content: [] }
    } })
    const driver = fakeDriver(() => ({ content: [] }))
    const cua = createCuaClient({ binary: binary(), missingMessage: 'missing', clientVersion: '1.0', home: dir, platform: 'darwin', socketPath: path.join(dir, 's'), spawn: driver.spawn })
    const published: Array<{ at: number; value: unknown }> = []
    const host = createDeviceActionHost({ provider: {
      manifest: () => [], permit: () => ({ ok: true }),
      run: async (_action, _args, ctx) => ({ ok: true, data: await cua.callTool('run_steps', { pid: 1, window_id: 2, steps: Array.from({ length: 7 }, () => ({ click: { role: 'button', name: '1' } })), observe: { include_screenshot: true } }, {
        lane: 'agent', timeoutMs: 75_000, signal: ctx.signal, remainingMs: ctx.remainingMs,
      }) }),
    }, publishEvent: value => { published.push({ at: Date.now(), value }) } })
    try {
      await cua.callTool('list_apps', {}, { lane: 'agent' })
      vi.useFakeTimers()
      const start = Date.now()
      await host.handleCall({ v: 1, call_id: 'budget', action: 'computer.run_steps', args: {}, timeout_ms: 60_000, deadline_at: new Date(start + 25_000).toISOString() })
      await vi.advanceTimersByTimeAsync(60_000)
      const event = published.find(entry => (entry.value as { type?: string }).type === DEVICE_ACTION_RESULT_EVENT)!
      expect(event.value).toMatchObject({ result: { ok: true, data: { structuredContent: {
        ok: true, executed: 7, total: 7, steps, observation: { ok: false, state: { observation_stability: { status: 'timeout' } } },
      } } } })
      expect(event.at - start).toBeLessThan(60_000)
      expect(calls.filter(name => name === 'run_steps')).toHaveLength(1)
      expect(calls.filter(name => name === 'get_window_state')).toHaveLength(1)
      expect(close).not.toHaveBeenCalled()
    } finally { host.dispose(); cua.dispose(); vi.useRealTimers() }
  })

  it.each(['budget', 'abort'] as const)('does not start a driver for an already exhausted %s', async mode => {
    vi.spyOn(daemonLeases, 'openCuaDaemonLease').mockResolvedValue({ close: vi.fn(), call: async () => ({ content: [] }) })
    const driver = fakeDriver(() => ({ content: [] }))
    const cua = createCuaClient({ binary: binary(), missingMessage: 'missing', clientVersion: '1.0', home: dir, platform: 'darwin', socketPath: path.join(dir, 's'), spawn: driver.spawn })
    const stop = new AbortController()
    if (mode === 'abort') stop.abort()
    try {
      await expect(cua.callTool('click', {}, { remainingMs: () => mode === 'budget' ? 0 : 60_000, signal: stop.signal })).rejects.toMatchObject({ code: mode === 'budget' ? 'timeout' : 'execution_failed' })
      expect(driver.spawned).toHaveLength(0)
    } finally { cua.dispose() }
  })

  it.each(['budget', 'abort'] as const)('rechecks %s after lane startup and never sends or replays the expired input', async mode => {
    let left = 60_000
    const stop = new AbortController()
    const tools: string[] = []
    let opened = 0
    vi.spyOn(daemonLeases, 'openCuaDaemonLease').mockImplementation(async () => {
      if (++opened === 2) {
        if (mode === 'budget') left = 0
        else stop.abort()
      }
      return { close: vi.fn(), call: async name => { tools.push(name); return { content: [] } } }
    })
    const driver = fakeDriver(() => ({ content: [] }))
    const cua = createCuaClient({ binary: binary(), missingMessage: 'missing', clientVersion: '1.0', home: dir, platform: 'darwin', socketPath: path.join(dir, 's'), spawn: driver.spawn })
    try {
      await cua.callTool('list_apps', {}, { lane: 'warm' })
      await expect(cua.callTool('click', {}, { lane: 'agent', remainingMs: () => left, signal: stop.signal })).rejects.toMatchObject({ code: mode === 'budget' ? 'timeout' : 'execution_failed' })
      expect(tools).toEqual(['list_apps'])
      await cua.callTool('click', {}, { lane: 'agent' })
      expect(tools).toEqual(['list_apps', 'click'])
    } finally { cua.dispose() }
  })

  it.each(['timeout', 'abort', 'lease-timeout'] as const)('retires only the input lane on %s, without replay or late-generation damage', async mode => {
    const generations: Array<{ owner: string; closed: ReturnType<typeof vi.fn>; onClosed: () => void }> = []
    const calls: Array<{ owner: string; name: string }> = []
    let lateReply = () => {}
    vi.spyOn(daemonLeases, 'openCuaDaemonLease').mockImplementation(async options => {
      const closed = vi.fn(() => options.onClosed())
      generations.push({ owner: options.owner, closed, onClosed: options.onClosed })
      return {
        close: closed,
        async call(name) {
          calls.push({ owner: options.owner, name })
          if (name === 'click') {
            if (mode === 'lease-timeout') throw new NativeCallError('timeout', 'lease timer won')
            return new Promise<{ content: [] }>(resolve => { lateReply = () => resolve({ content: [] }) })
          }
          return { content: [] }
        },
      }
    })
    const driver = fakeDriver(() => ({ content: [] }))
    const cua = createCuaClient({ binary: binary(), missingMessage: 'missing', clientVersion: '1.0', home: dir, platform: 'darwin', socketPath: path.join(dir, 's'), spawn: driver.spawn })
    try {
      await cua.callTool('list_windows', {}, { lane: 'a' })
      await cua.callTool('list_windows', {}, { lane: 'b' })
      const stop = new AbortController()
      const clicked = cua.callTool('click', { pid: 1, window_id: 2 }, { lane: 'a', timeoutMs: mode === 'timeout' ? 40 : 1000, signal: stop.signal })
      const rejected = expect(clicked).rejects.toMatchObject({ code: mode === 'abort' ? 'execution_failed' : 'timeout' })
      await expect.poll(() => calls.some(call => call.name === 'click')).toBe(true)
      if (mode === 'abort') stop.abort()
      await rejected
      expect(generations[0]!.closed).toHaveBeenCalled()
      expect(generations[1]!.closed).not.toHaveBeenCalled()
      await cua.callTool('list_windows', {}, { lane: 'a' })
      expect(generations).toHaveLength(3)
      expect(generations[2]!.owner).not.toBe(generations[0]!.owner)
      lateReply()
      await new Promise(resolve => setImmediate(resolve))
      generations[0]!.onClosed()
      await cua.callTool('list_windows', {}, { lane: 'a' })
      await cua.callTool('list_windows', {}, { lane: 'b' })
      expect(generations).toHaveLength(3)
      expect(calls.filter(call => call.name === 'click')).toHaveLength(1)
      expect(driver.spawned).toHaveLength(1)
    } finally { cua.dispose() }
  })

  it('logs only fixed native timing/warning events across stderr chunks and ANSI, preserving the tail', async () => {
    const driver = fakeDriver(() => ({ content: [] }))
    const log = { info: vi.fn(), warn: vi.fn() }
    const cua = createCuaClient({ binary: binary(), missingMessage: 'missing', clientVersion: '1.0', home: dir, platform: 'linux', socketPath: path.join(dir, 's'), spawn: driver.spawn, log })
    try {
      await cua.callTool('list_apps', {})
      const daemon = driver.spawned[0]!.proc
      daemon.stderr.write('private AX content\n\u001b[2m2026-10-19T09:00:00Z\u001b[0m INFO cua_driver_core::tool: cua input ti')
      expect(log.info).not.toHaveBeenCalled()
      daemon.stderr.write('ming tool="click" phase="admitted" elapsed_ms=8 lock_wait_ms=5 session="opaque-a" pid=123 window_id=456 input="secret" ax="tool=secret phase=payload"\n')
      daemon.stderr.write('2026-10-19T09:00:01Z WARN platform_macos::cursor::overlay: cursor overlay: no arrival within 8s; continuing without it\n')
      daemon.stderr.write('2026-10-19T09:00:02Z INFO something: unrelated secret\n')
      daemon.stderr.write('2026-10-19T09:00:03Z INFO something: unrelated ax="cua input timing tool=secret"\n')
      daemon.stderr.write('2026-10-19T09:00:04Z INFO platform_macos::cursor::overlay: cua input timing phase="cursor_frame" dt_ms=16.25\n')
      daemon.stderr.write('2026-10-19T09:00:05Z INFO platform_macos::cursor::overlay: cua input timing phase="cursor_arrival" arrived=false elapsed_ms=8000\n')
      daemon.stderr.write('2026-10-19T09:00:06Z INFO platform_macos::cursor::overlay: cua input timing phase="cursor_arrival" arrived=true elapsed_ms=8\n')
      daemon.stderr.write('2026-10-19T09:00:07Z INFO platform_macos::cursor::overlay: cua input timing phase="cursor_frame" dt_ms=NaN arrived="true"\n')
      expect(log.info).toHaveBeenCalledTimes(5)
      expect(log.info.mock.calls[0]?.[0]).toMatchObject({ event: 'cua_input_timing', nativeAt: '2026-10-19T09:00:00Z', tool: 'click', phase: 'admitted', elapsed_ms: 8, lock_wait_ms: 5, session: 'opaque-a', pid: 123, window_id: 456 })
      expect(log.info.mock.calls[1]?.[0]).toMatchObject({ phase: 'cursor_frame', dt_ms: 16.25 })
      expect(log.info.mock.calls[2]?.[0]).toMatchObject({ phase: 'cursor_arrival', arrived: false, elapsed_ms: 8000 })
      expect(log.info.mock.calls[3]?.[0]).toMatchObject({ phase: 'cursor_arrival', arrived: true, elapsed_ms: 8 })
      expect(log.info.mock.calls[4]?.[0]).not.toHaveProperty('dt_ms')
      expect(log.info.mock.calls[4]?.[0]).not.toHaveProperty('arrived')
      expect(log.warn).toHaveBeenCalledTimes(1)
      expect(log.warn.mock.calls[0]?.[0]).toMatchObject({ event: 'cursor_arrival_timeout', nativeAt: '2026-10-19T09:00:01Z' })
      expect(JSON.stringify([log.info.mock.calls, log.warn.mock.calls])).not.toMatch(/secret|private AX|input=/)
      daemon.emit('exit', 1, null)
      expect(log.info).toHaveBeenLastCalledWith(expect.objectContaining({ stderrTail: expect.stringContaining('dt_ms=NaN') }), 'cua-driver serve exited')
    } finally { cua.dispose() }
  })
  it('先起 serve --embedded,socket 好了再起 mcp --embedded 连同一个 socket;initialize 之后才调工具', async () => {
    const driver = fakeDriver(() => ({ content: [{ type: 'text', text: 'ok' }], structuredContent: { apps: [] } }))
    const socket = path.join(dir, 's.sock')
    const client = createCuaClient({ binary: binary(), missingMessage: 'missing', clientVersion: '1.0', home: path.join(dir, 'home'), platform: 'linux', socketPath: socket, spawn: driver.spawn })
    expect(await client.callTool('list_apps', {})).toEqual({ content: [{ type: 'text', text: 'ok' }], structuredContent: { apps: [] } })
    expect(driver.spawned.map((s) => s.args)).toEqual([
      ['serve', '--embedded', '--socket', socket, '--pid-file', `${socket}.pid`],
      ['mcp', '--embedded', '--socket', socket],
    ])
    expect(driver.received.map((m) => m.method)).toEqual(['initialize', 'notifications/initialized', 'tools/call'])
    expect(driver.spawned[0]!.env.CUA_DRIVER_EMBEDDED).toBe('1')
    // #7317: the daemon treats its stdin as 咕咕 being alive and quits when it closes; the proxy's stdin is its JSON-RPC.
    expect(driver.spawned[0]!.env.CUA_DRIVER_PARENT_LIVENESS_STDIN).toBe('1')
    expect(driver.spawned[1]!.env.CUA_DRIVER_PARENT_LIVENESS_STDIN).toBeUndefined()
    // 第二次调用复用同一代。
    await client.callTool('list_apps', {})
    expect(driver.spawned).toHaveLength(2)
    client.dispose()
  })

  it('超时只撤这一个调用(notifications/cancelled),守护进程留着给别人用', async () => {
    const driver = fakeDriver((name) => (name === 'slow' ? undefined : { content: [] }))
    const client = createCuaClient({ binary: binary(), missingMessage: 'missing', clientVersion: '1.0', home: path.join(dir, 'home'), platform: 'linux', socketPath: path.join(dir, 's.sock'), spawn: driver.spawn })
    // Exercise cancellation after dispatch, independently of cold lane startup.
    await client.callTool('fast', {})
    await expect(client.callTool('slow', {}, { timeoutMs: 50 })).rejects.toMatchObject({ code: 'timeout' })
    const cancelled = driver.received.find((m) => m.method === 'notifications/cancelled') as { params: { requestId: number } } | undefined
    const slowCall = driver.received.find((m) => m.method === 'tools/call' && (m.params as { name?: string })?.name === 'slow') as { id: number }
    expect(cancelled?.params.requestId).toBe(slowCall.id)
    expect(driver.spawned.every((s) => !s.proc.killed)).toBe(true)
    expect(await client.callTool('fast', {})).toEqual({ content: [] })
    client.dispose()
  })

  it('急停:两个进程一起关,在途的调用以原因失败;下一次调用重起一代', async () => {
    const driver = fakeDriver((name) => (name === 'slow' ? undefined : { content: [] }))
    const client = createCuaClient({ binary: binary(), missingMessage: 'missing', clientVersion: '1.0', home: path.join(dir, 'home'), platform: 'linux', socketPath: path.join(dir, 's.sock'), spawn: driver.spawn })
    await client.callTool('fast', {})
    const pending = client.callTool('slow', {}, { timeoutMs: 10_000 })
    await new Promise((r) => setTimeout(r, 10))
    client.stop('人按了停止')
    await expect(pending).rejects.toThrow('人按了停止')
    expect(driver.spawned.slice(0, 2).every((s) => s.proc.killed)).toBe(true)
    await client.callTool('fast', {})
    expect(driver.spawned.map((s) => s.args[0])).toEqual(['serve', 'mcp', 'serve', 'mcp'])
    client.dispose()
  })

  it('没带 cua-driver(开发环境没编)→ unsupported,说清怎么补', async () => {
    const client = createCuaClient({ binary: path.join(dir, 'nope'), missingMessage: '还没编原生组件', clientVersion: '1.0', home: dir, platform: 'darwin' })
    expect(client.available()).toMatchObject({ ok: false, message: expect.stringContaining('还没编原生组件') })
    await expect(client.callTool('list_apps', {})).rejects.toMatchObject({ code: 'unsupported' })
  })

  it('守护进程起来就退出:报出来,❌ 一直等', async () => {
    const spawn = (_c: string, args: readonly string[]) => {
      const proc = new FakeProc()
      if (args[0] === 'serve') setTimeout(() => { proc.exitCode = 1; proc.emit('exit', 1, null) }, 10)
      return proc as never
    }
    const client = createCuaClient({ binary: binary(), missingMessage: 'missing', clientVersion: '1.0', home: dir, platform: 'linux', socketPath: path.join(dir, 's.sock'), spawn, readyTimeoutMs: 2_000 })
    await expect(client.callTool('list_apps', {})).rejects.toThrow(/退出|exited|起来/)
  })
})
