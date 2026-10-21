import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCuaClient } from '../../../../apps/desktop/electron/device-actions/native/cua-client'

/**
 * #7317 真机:两个任务 + 「电脑」页签同时用电脑时,每一步 18–30 秒、一次读窗口 30 秒超时。cua-driver-rs v0.35.4 的 `mcp` 代理
 * 一次只办一个请求(读一行 → 等守护进程答完 → 写回 → 再读,proxy.rs),守护进程却每条连接各开一个任务(serve.rs),而咕咕
 * 整台机器只起了一个代理 ⇒ 所有 agent 和预览排成一队。这里的假代理照它那样一次办一个,测「一个会话一条道」。
 * 另:cua 的有名会话会被它自己结束(闲置清扫等),普通调用从此被拒,只有 start_session 能把同名的开回来(它的工具说明原话)。
 */

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

type Call = { name: string; args: Record<string, unknown>; proxy: number }
let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-cua-lanes-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

/** 假的 cua-driver:每个 mcp 代理一次只办一个请求,办完才读下一行;answer 可以是异步的。 */
function serialDriver(answer: (call: Call) => unknown | Promise<unknown>, options: { socketAfterMs?: number; answersInitialize?: boolean } = {}) {
  const proxies: FakeProc[] = []
  const calls: Call[] = []
  const spawn = (_command: string, args: readonly string[]) => {
    const proc = new FakeProc()
    if (args[0] === 'serve') {
      const socket = args[args.indexOf('--socket') + 1]!
      setTimeout(() => fs.writeFileSync(socket, ''), options.socketAfterMs ?? 5)
      return proc as never
    }
    const index = proxies.push(proc) - 1
    let buf = ''
    let queue = Promise.resolve()
    proc.stdin.on('data', (chunk: Buffer) => {
      buf += chunk.toString()
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, i)) as { id?: number; method: string; params?: { name: string; arguments: Record<string, unknown> } }
        buf = buf.slice(i + 1)
        // Notifications (cancelled included) are dropped, as the real proxy does.
        if (msg.id === undefined) continue
        queue = queue.then(async () => {
          if (msg.method === 'initialize') {
            if (options.answersInitialize !== false) proc.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} })}\n`)
            return
          }
          const call = { name: msg.params!.name, args: msg.params!.arguments, proxy: index }
          calls.push(call)
          const result = await answer(call)
          if (!proc.killed) proc.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n`)
        })
      }
    })
    return proc as never
  }
  return { spawn, proxies, calls }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const client = (spawn: unknown, readyTimeoutMs = 2_000) => {
  const binary = path.join(dir, 'cua-driver')
  fs.writeFileSync(binary, '')
  return createCuaClient({ binary, missingMessage: 'missing', clientVersion: '1.0', home: path.join(dir, 'home'), platform: 'linux', socketPath: path.join(dir, 's.sock'), spawn: spawn as never, readyTimeoutMs })
}
const text = (value: string) => ({ content: [{ type: 'text', text: value }] })

describe('#7317 one lane per cua session', () => {
  it.each(['timeout', 'abort'] as const)('an input %s retires only its proxy generation; its old exit cannot close the replacement', async mode => {
    const driver = serialDriver(call => call.name === 'click' ? new Promise(() => undefined) : text('ok'))
    const cua = client(driver.spawn)
    try {
      await cua.callTool('list_windows', {}, { lane: 'a' })
      await cua.callTool('list_windows', {}, { lane: 'b' })
      const stop = new AbortController()
      const pending = cua.callTool('click', {}, { lane: 'a', timeoutMs: mode === 'timeout' ? 40 : 1000, signal: stop.signal }).catch((error: unknown) => error)
      await expect.poll(() => driver.calls.some(call => call.name === 'click')).toBe(true)
      if (mode === 'abort') stop.abort()
      expect(await pending).toMatchObject({ message: expect.stringMatching(/结果未确认/) })
      expect(driver.proxies[0]!.killed).toBe(true)
      expect(driver.proxies[1]!.killed).toBe(false)
      await cua.callTool('list_windows', {}, { lane: 'a' })
      driver.proxies[0]!.emit('exit', null, 'SIGTERM')
      await cua.callTool('list_windows', {}, { lane: 'a' })
      await cua.callTool('list_windows', {}, { lane: 'b' })
      expect(driver.proxies).toHaveLength(3)
      expect(driver.calls.filter(call => call.name === 'click')).toHaveLength(1)
    } finally { cua.dispose() }
  })

  it('an observation timeout on a busy lane does not stop its input or replace its proxy', async () => {
    let finish = () => {}
    const driver = serialDriver(call => call.name === 'click' ? new Promise(resolve => { finish = () => resolve(text('clicked')) }) : text('window'))
    const cua = client(driver.spawn)
    try {
      await cua.callTool('list_windows', {}, { lane: 'a' })
      const input = cua.callTool('click', {}, { lane: 'a' })
      await expect.poll(() => driver.calls.some(call => call.name === 'click')).toBe(true)
      await expect(cua.callTool('get_window_state', {}, { lane: 'a', timeoutMs: 30 })).rejects.toMatchObject({ code: 'timeout' })
      expect(driver.proxies[0]!.killed).toBe(false)
      finish()
      expect(await input).toEqual(text('clicked'))
      expect(await cua.callTool('list_windows', {}, { lane: 'a' })).toEqual(text('window'))
      expect(driver.proxies).toHaveLength(1)
    } finally { cua.dispose() }
  })
  it('two agents\' calls run side by side; one agent\'s calls stay on its own lane', async () => {
    let active = 0
    let most = 0
    const driver = serialDriver(async (call) => {
      active += 1
      most = Math.max(most, active)
      await sleep(60)
      active -= 1
      return text(`${call.name} done`)
    })
    const cua = client(driver.spawn)
    await Promise.all([
      cua.callTool('get_window_state', { session: 'gugu-aaaaaaaaaa', pid: 1, window_id: 2 }),
      cua.callTool('get_window_state', { session: 'gugu-bbbbbbbbbb', pid: 3, window_id: 4 }),
    ])
    // Behind one proxy the second waits for the first; on two lanes the driver has both at once.
    expect(most).toBe(2)
    expect(driver.proxies).toHaveLength(2)
    // A call without a session of its own goes on the lane it names: the same agent's.
    await cua.callTool('list_windows', { pid: 1 }, { lane: 'gugu-aaaaaaaaaa' })
    expect(driver.calls.at(-1)!.proxy).toBe(driver.calls[0]!.proxy)
    expect(driver.calls[0]!.args.session).not.toBe(driver.calls[1]!.args.session)
    cua.dispose()
  })

  it('the preview\'s look at a window never waits behind an agent\'s step', async () => {
    let release = () => {}
    const driver = serialDriver((call) => (call.args.display_only ? new Promise((resolve) => { release = () => resolve(text('picture')) }) : text('clicked')))
    const cua = client(driver.spawn)
    const peek = cua.callTool('get_window_state', { pid: 1, window_id: 2, display_only: true }, { lane: 'gugu-preview' })
    await sleep(20)
    // The look is still going; the agent's click is answered all the same.
    expect(await cua.callTool('click', { session: 'gugu-aaaaaaaaaa', pid: 1, window_id: 2, x: 1, y: 1 })).toEqual(text('clicked'))
    release()
    expect(await peek).toEqual(text('picture'))
    cua.dispose()
  })

  it('a session cua ended is started again under the same name, and the call is made once more', async () => {
    let ended = true
    const driver = serialDriver((call) => {
      if (call.name === 'start_session') {
        ended = false
        return { content: [{ type: 'text', text: 'started' }], structuredContent: { session: call.args.session } }
      }
      return ended
        ? { isError: true, content: [{ type: 'text', text: `session has ended; tool call '${call.name}' was rejected. Call start_session with session '${String(call.args.session)}' to start it again, or use a new session label.` }] }
        : text('fresh window')
    })
    const cua = client(driver.spawn)
    expect(await cua.callTool('get_window_state', { session: 'gugu-bbbbbbbbbb', pid: 3, window_id: 4 })).toEqual(text('fresh window'))
    const session = driver.calls[0]!.args.session
    expect(session).toEqual(expect.stringMatching(/^gugu-bbbbbbbbbb-/))
    expect(driver.calls.map((call) => [call.name, call.args.session])).toEqual([
      ['get_window_state', session],
      ['start_session', session],
      ['get_window_state', session],
    ])
    // All three on that session's own lane: cua binds a session to the connection that started it.
    expect(new Set(driver.calls.map((call) => call.proxy)).size).toBe(1)
    cua.dispose()
  })

  it('a replacement proxy uses a fresh driver session; the ended name belongs to the old transport', async () => {
    const owners = new Map<string, number>()
    const driver = serialDriver((call) => {
      const session = String(call.args.session)
      const owner = owners.get(session)
      if (owner !== undefined && owner !== call.proxy) {
        return { isError: true, content: [{ type: 'text', text: call.name === 'start_session'
          ? 'session is not available to this transport'
          : `session has ended; tool call '${call.name}' was rejected. Call start_session with session '${session}' to start it again, or use a new session label.` }] }
      }
      owners.set(session, call.proxy)
      return text('fresh window')
    })
    const cua = client(driver.spawn)
    try {
      const args = { session: 'gugu-914fd63d18', pid: 3, window_id: 4 }
      expect(await cua.callTool('get_window_state', args)).toEqual(text('fresh window'))
      driver.proxies[0]!.kill()
      await sleep(20)
      expect(await cua.callTool('get_window_state', args)).toEqual(text('fresh window'))
      expect(driver.proxies).toHaveLength(2)
      expect(driver.calls.map((call) => call.name)).toEqual(['get_window_state', 'get_window_state'])
      expect(driver.calls[0]!.args.session).not.toBe(driver.calls[1]!.args.session)
      expect(args.session).toBe('gugu-914fd63d18')
    } finally {
      cua.dispose()
    }
  })

  it('when cua will not start it again, the call\'s own refusal is what comes back; other errors are not retried', async () => {
    const refusal = { isError: true, content: [{ type: 'text', text: "session has ended; tool call 'click' was rejected." }] }
    const driver = serialDriver((call) => (call.name === 'start_session' ? { isError: true, content: [{ type: 'text', text: 'nope' }] } : call.name === 'click' ? refusal : { isError: true, content: [{ type: 'text', text: 'window_id_not_found' }] }))
    const cua = client(driver.spawn)
    expect(await cua.callTool('click', { session: 'gugu-aaaaaaaaaa', x: 1, y: 1 })).toEqual(refusal)
    expect(driver.calls.map((call) => call.name)).toEqual(['click', 'start_session'])
    await cua.callTool('get_window_state', { session: 'gugu-aaaaaaaaaa', pid: 1, window_id: 9 })
    expect(driver.calls.map((call) => call.name)).toEqual(['click', 'start_session', 'get_window_state'])
    cua.dispose()
  })

  it('starting again right after a stop keeps the new daemon\'s socket', async () => {
    // The stop's cleanup of the old socket must be done before the next daemon makes its own. Left to the thread pool, a
    // busy machine runs it late, it takes the new socket with it, and the start waits out its whole limit for nothing
    // (seen as this file hanging 3 runs in 5). The busy pool is made here: an fs.rm that runs 30 ms late.
    const rm = fs.rm
    const late = vi.spyOn(fs, 'rm').mockImplementation(((target: fs.PathLike, options: fs.RmOptions, done: fs.NoParamCallback) => {
      setTimeout(() => rm(target, options, done), 30)
    }) as typeof fs.rm)
    try {
      const driver = serialDriver(() => text('ok'))
      const cua = client(driver.spawn)
      await cua.callTool('list_apps', {})
      cua.stop('系统授权变了')
      expect(await cua.callTool('list_apps', {})).toEqual(text('ok'))
      cua.dispose()
    } finally {
      late.mockRestore()
    }
  })

  it('a call cancelled while its lane is starting is never sent; one that runs out of time there says it was not sent', async () => {
    // A daemon slow to open its socket (a busy Mac): the person presses Stop meanwhile.
    const driver = serialDriver(() => text('clicked'), { socketAfterMs: 150 })
    const cua = client(driver.spawn)
    const stop = new AbortController()
    const click = cua.callTool('click', { session: 'gugu-aaaaaaaaaa', x: 1, y: 1 }, { signal: stop.signal })
    await sleep(20)
    stop.abort()
    await expect(click).rejects.toThrow('已取消')
    const late = cua.callTool('list_apps', { session: 'gugu-bbbbbbbbbb' }, { timeoutMs: 40 })
    await expect(late).rejects.toThrow(/没有发出去/)
    await sleep(250)
    // The lanes came up after all, and neither call reached the computer.
    expect(driver.calls).toEqual([])
    // Control: the next call on that lane is sent and answered.
    expect(await cua.callTool('click', { session: 'gugu-aaaaaaaaaa', x: 1, y: 1 })).toEqual(text('clicked'))
    expect(driver.calls.map((call) => call.name)).toEqual(['click'])
    cua.dispose()
  })

  it('a proxy that never answers initialize is given up on in the start\'s own time, and closed', async () => {
    const driver = serialDriver(() => text('ok'), { answersInitialize: false })
    const cua = client(driver.spawn, 200)
    await expect(cua.callTool('list_apps', {}, { timeoutMs: 5_000 })).rejects.toThrow(/没能启动/)
    expect(driver.proxies[0]!.killed).toBe(true)
    cua.dispose()
  })

  it('a proxy whose pipe has closed fails the call at once, and its pipe error is no crash', async () => {
    const driver = serialDriver(() => text('ok'))
    const cua = client(driver.spawn)
    await cua.callTool('list_apps', { session: 'gugu-aaaaaaaaaa' })
    const proxy = driver.proxies[0]!
    proxy.stdin.end()
    await expect(cua.callTool('list_apps', { session: 'gugu-aaaaaaaaaa' }, { timeoutMs: 5_000 })).rejects.toThrow(/连接断了/)
    expect(() => proxy.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).not.toThrow()
    cua.dispose()
  })

  it('once 咕咕 quits, a late call does not start cua-driver again', async () => {
    const driver = serialDriver(() => text('ok'))
    const cua = client(driver.spawn)
    await cua.callTool('list_apps', {})
    cua.dispose()
    await expect(cua.callTool('list_apps', {})).rejects.toThrow(/正在退出/)
    expect(driver.proxies).toHaveLength(1)
  })

  it('a lane whose proxy exits fails only its own calls; the next call opens it again', async () => {
    const driver = serialDriver(async (call) => {
      if (call.name === 'hang') return new Promise(() => undefined)
      await sleep(30)
      return text('ok')
    })
    const cua = client(driver.spawn)
    await cua.callTool('list_apps', { session: 'gugu-aaaaaaaaaa' })
    const hanging = cua.callTool('hang', { session: 'gugu-aaaaaaaaaa' }, { timeoutMs: 10_000 })
    const other = cua.callTool('list_apps', { session: 'gugu-bbbbbbbbbb' })
    await sleep(20)
    driver.proxies[0]!.kill()
    await expect(hanging).rejects.toThrow(/连接断了/)
    expect(await other).toEqual(text('ok'))
    expect(await cua.callTool('list_apps', { session: 'gugu-aaaaaaaaaa' })).toEqual(text('ok'))
    expect(driver.proxies).toHaveLength(3)
    cua.dispose()
  })
})
