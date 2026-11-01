/**
 * #7199「电脑控制」= trycua/cua 的 cua-driver(MIT,v0.36.0,scripts/build/build-mac-native.mjs 随包带上)。
 * 它在后台操作别的 App:❌ 抢人的焦点、❌ 动人的真鼠标,并在屏幕上画一个 agent 自己的鼠标。
 *
 * 照它的嵌入说明起守护进程,直接从咕咕主进程 spawn(❌ open / NSWorkspace):
 * - `cua-driver serve --embedded --socket <私有路径>`:守护进程,真正干活;是咕咕的子进程 ⇒ 辅助功能、屏幕录制两项系统授权
 *   记在咕咕名下,它自己从不弹授权框。agent 鼠标也只有守护进程画得出(`mcp --direct` 实测报 facility_unavailable)。
 * - macOS:宿主按原生 daemon 协议维护每个 agent 的 control lease,每次请求走独立连接；
 *   同一 owner 的只读光标采样可以与它的批次并行,不拿计划路径预演真实操作。
 * - 其他平台仍用每个 agent 一份 `mcp --embedded` 代理,与预览分道,互不排队。
 * 系统授权变了要整个重起才认(它按进程缓存授权)。闲 10 分钟关掉(连带收掉屏幕上的 agent 鼠标)。
 *
 * 环境变量只给白名单里的几样:❌ 把咕咕的整份环境(含各种 key)交给第三方进程。它默认会上报使用数据、查更新、写 ~/.cua-driver,
 * 这里一律关掉 / 挪进咕咕自己的数据目录。
 */
import type { ChildProcess } from 'node:child_process'
import { spawn as nodeSpawn } from '@gugu/core/local/childProcess'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { stripVTControlCharacters } from 'node:util'
import { NativeCallError } from './mac-helper-client'
import { CUA_CANCEL_UNCONFIRMED, cuaMutates, openCuaDaemonLease, type CuaDaemonLease } from './cua-daemon-lease'
import { batchObservation, batchObservationArgs, createObservationGate, displayOnlyObservation, replaceBatchObservation, settleCuaWindow, transientObservationError } from './cua-observation'

export interface CuaContentBlock {
  type: string
  text?: string
  data?: string
  mimeType?: string
  [key: string]: unknown
}

export interface CuaToolResult {
  content?: CuaContentBlock[]
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

export interface CuaClient {
  available(): { ok: true } | { ok: false; message: string }
  /**
   * 带 `session` 的调用走那个会话自己的道(会话归开它的那条道:换道 cua 会拒);不带的走 `lane`(调用方自己的会话名,
   * 或预览这类不代表任何 agent 的),都没有就走公用的那条。
   */
  callTool(name: string, args: Record<string, unknown>, options?: { signal?: AbortSignal; timeoutMs?: number; lane?: string; remainingMs?: () => number }): Promise<CuaToolResult>
  /** Host-only read of an existing agent's real cursor, without queueing behind its batch or creating a new agent session. */
  cursorState?(session: string, signal?: AbortSignal): Promise<CuaToolResult | null>
  /** 立刻停:守护进程和代理一起关(屏幕上的 agent 鼠标随之消失),在途的调用都以 reason 失败;下一次调用再重起。 */
  stop(reason: string): void
  dispose(): void
}

type Log = { info(fields: Record<string, unknown>, msg: string): void; warn(fields: Record<string, unknown>, msg: string): void }
type Spawn = (command: string, args: readonly string[], options: { env: NodeJS.ProcessEnv; stdio: ['pipe', 'pipe', 'pipe'] }) => ChildProcess

const IDLE_MS = 10 * 60_000
const READY_MS = 15_000
/** 一条道这么久没有调用就关掉它的代理(它名下的 cua 会话随之结束,下次用到时再开起来)。 */
const LANE_IDLE_MS = 10 * 60_000
/** 比这慢的调用记一行:时间花在起进程、排队还是驱动自己。 */
const SLOW_MS = 10_000
/** Leave time for provider image conversion and publishing before host abort. */
const RETURN_RESERVE_MS = 500
const INPUTS = new Set(['click', 'double_click', 'right_click', 'drag', 'scroll', 'type_text', 'press_key', 'hotkey', 'set_value', 'set_window_frame', 'invoke_menu', 'run_steps'])

// 给人(和 agent)看的只说下一步怎么办;退出码、stderr、系统报错原文一律进日志。
const START_FAILED = '电脑控制没能启动：请退出咕咕再重新打开；还不行就重新安装咕咕'
const CRASHED = '电脑控制意外停了：再调一次会自动重新启动'
const DISCONNECTED = '电脑控制的连接断了：再调一次会自动重新连上'

/** 交给 cua-driver 的环境:系统要的几样 + 它自己的开关。 */
const PASS_THROUGH = ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'CUA_LOG', 'SystemRoot', 'windir', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'ComSpec', 'PATHEXT', 'SystemDrive', 'ProgramData']

export function cuaEnvironment(input: { home: string; hostBundleId?: string; source?: NodeJS.ProcessEnv }): NodeJS.ProcessEnv {
  const source = input.source ?? process.env
  const env: NodeJS.ProcessEnv = {}
  for (const key of PASS_THROUGH) if (source[key] !== undefined) env[key] = source[key]
  return {
    ...env,
    CUA_DRIVER_EMBEDDED: '1',
    // 默认的 standard:看、点、输、滚不逐次要批;接管已登录的浏览器、杀别人的进程、从工具里弹系统授权一律拒。
    CUA_DRIVER_PERMISSION_MODE: 'standard',
    CUA_DRIVER_RS_TELEMETRY_ENABLED: 'false',
    CUA_DRIVER_RS_UPDATE_CHECK: 'false',
    CUA_DRIVER_RS_HOME: input.home,
    ...(input.hostBundleId ? { CUA_DRIVER_HOST_BUNDLE_ID: input.hostBundleId } : {}),
  }
}

/** 守护进程的私有通道:Unix 上是临时目录里的 socket(macOS 限 104 字节,❌ 放进带中文的数据目录),Windows 上是命名管道。 */
export function cuaSocketPath(platform: NodeJS.Platform = process.platform, pid = process.pid): string {
  return platform === 'win32' ? `\\\\.\\pipe\\gugu-cua-${pid}` : path.join(os.tmpdir(), `gugu-cua-${pid}.sock`)
}

const pipeAccepting = (pipe: string) =>
  new Promise<boolean>((resolve) => {
    const socket = net.connect(pipe)
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => resolve(false))
  })

export function createCuaClient(options: {
  binary: string | null
  missingMessage: string
  clientVersion: string
  /** CUA_DRIVER_RS_HOME:它的配置、缓存放这里。 */
  home: string
  hostBundleId?: string
  platform?: NodeJS.Platform
  socketPath?: string
  /** Desktop decoder normalizes native PNG encodings for visual stability. */
  sampleImage?: (base64: string) => Uint8Array
  log?: Log
  /** 测试注入。 */
  spawn?: Spawn
  readyTimeoutMs?: number
  laneIdleMs?: number
}): CuaClient {
  const platform = options.platform ?? process.platform
  const socket = options.socketPath ?? cuaSocketPath(platform)
  const spawn: Spawn = options.spawn ?? ((command, args, spawnOptions) => nodeSpawn(command, args, spawnOptions))
  const laneIdleMs = options.laneIdleMs ?? LANE_IDLE_MS
  let daemon: ChildProcess | null = null
  let daemonReady: Promise<void> | null = null
  let nextId = 1
  let idle: ReturnType<typeof setTimeout> | null = null
  type Pending = Map<number, { resolve(value: unknown): void; reject(error: Error): void }>
  // 在途请求按代理进程记:旧的那一代迟一步退出时只拒它自己的,❌ 连带拒掉已经发给新一代的。
  const pendingOf = new WeakMap<ChildProcess, Pending>()
  /** 一条道:一个代理进程,一次办一个请求。`settledAt` = 这条道上最近一个调用回来的时刻(算排队用)。 */
  interface Lane { ready: Promise<ChildProcess>; proc: ChildProcess | null; direct?: CuaDaemonLease; session: string; inflight: number; settledAt: number; idle: ReturnType<typeof setTimeout> | null }
  const lanes = new Map<string, Lane>()
  const needsObservation = new Set<string>()
  const observations = createObservationGate()
  let disposed = false

  const failAll = (proc: ChildProcess, error: Error) => {
    const pending = pendingOf.get(proc)
    if (!pending) return
    for (const [id, p] of pending) {
      p.reject(error)
      pending.delete(id)
    }
  }

  /** false = 这个进程的 stdin 已经关了(它退了、正在被关):❌ 往里写(写了是 EPIPE / write after end)。 */
  const write = (proc: ChildProcess, message: unknown): boolean => {
    const stdin = proc.stdin
    if (!stdin || stdin.destroyed || stdin.writableEnded) return false
    stdin.write(`${JSON.stringify(message)}\n`)
    return true
  }

  const request = (proc: ChildProcess, method: string, params: unknown): { id: number; done: Promise<unknown> } => {
    const id = nextId++
    const done = new Promise<unknown>((resolve, reject) => {
      pendingOf.get(proc)?.set(id, { resolve, reject })
      if (write(proc, { jsonrpc: '2.0', id, method, params })) return
      pendingOf.get(proc)?.delete(id)
      reject(new NativeCallError('execution_failed', DISCONNECTED))
    })
    return { id, done }
  }

  /**
   * 等 work,但最多等 timeoutMs、人一取消就不等:起道(守护进程、代理、initialize)这一段也算这一次调用的,
   * ❌ 人按了停止、道起好了照样把这一下发出去;❌ 起不来就一直挂着(「正在操作」小条永远不收)。
   */
  const within = <T,>(work: Promise<T>, timeoutMs: number, timedOut: () => NativeCallError, signal?: AbortSignal): Promise<T> => {
    if (signal?.aborted) return Promise.reject(new NativeCallError('execution_failed', '已取消'))
    return new Promise<T>((resolve, reject) => {
      const settle = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
      const timer = setTimeout(() => {
        settle()
        reject(timedOut())
      }, timeoutMs)
      const onAbort = () => {
        settle()
        reject(new NativeCallError('execution_failed', '已取消'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      work.then(
        (value) => {
          settle()
          resolve(value)
        },
        (error: unknown) => {
          settle()
          reject(error)
        },
      )
    })
  }

  const closeLane = (key: string, lane: Lane, reason: string) => {
    if (lanes.get(key) === lane) {
      lanes.delete(key)
      needsObservation.delete(key)
    }
    if (lane.idle) clearTimeout(lane.idle)
    lane.idle = null
    if (lane.direct) {
      lane.direct.close()
      return
    }
    const p = lane.proc
    if (!p) return
    failAll(p, new NativeCallError('execution_failed', reason))
    p.stdin?.end()
    p.kill()
  }

  const shutdown = (reason: string) => {
    if (idle) clearTimeout(idle)
    idle = null
    for (const [key, lane] of [...lanes]) closeLane(key, lane, reason)
    const oldDaemon = daemon
    daemon = null
    daemonReady = null
    oldDaemon?.kill()
    // 同步删:异步的这一下可能晚于紧接着起来的新一代建好 socket,把新的删掉(新一代干等 15 秒报「没能启动」)。
    // 旧的守护进程退出时只删它自己绑的那个(cua 核 inode),不碰新的。
    if (platform !== 'win32') {
      try {
        fs.rmSync(socket, { force: true })
      } catch (error) {
        options.log?.warn({ err: String(error) }, 'cua-driver socket could not be removed')
      }
    }
  }

  const waitForSocket = async (child: ChildProcess) => {
    const deadline = Date.now() + (options.readyTimeoutMs ?? READY_MS)
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        options.log?.warn({ code: child.exitCode, signal: child.signalCode }, 'cua-driver serve exited before its socket was ready')
        throw new NativeCallError('execution_failed', START_FAILED)
      }
      if (platform === 'win32' ? await pipeAccepting(socket) : fs.existsSync(socket)) return
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    options.log?.warn({ timeoutMs: options.readyTimeoutMs ?? READY_MS }, 'cua-driver serve did not open its socket in time')
    throw new NativeCallError('execution_failed', START_FAILED)
  }

  const environment = () => cuaEnvironment({ home: options.home, ...(options.hostBundleId ? { hostBundleId: options.hostBundleId } : {}) })

  /** 守护进程:正在起 / 已经起好就是同一代。它退出、出错、stop 都会清掉 daemonReady(连同所有的道),下一次才重起。 */
  const startDaemon = (): Promise<void> => {
    if (daemonReady) return daemonReady
    // shutdown 已经同步删过旧 socket(删不掉只记一笔):❌ 这里再删一遍,删不掉就把裸的 fs 错误抛给 agent。
    shutdown('电脑控制重新启动了')
    fs.mkdirSync(options.home, { recursive: true })
    const serveArgs = ['serve', '--embedded', '--socket', socket, ...(platform === 'win32' ? [] : ['--pid-file', `${socket}.pid`])]
    // CUA_DRIVER_PARENT_LIVENESS_STDIN:守护进程把 stdin 当作咕咕还活着的凭据,咕咕一没(含崩溃、被强杀)它就 EOF 自己退
    // (它的 EMBEDDING.md「host death closes the daemon」)。没有它,咕咕走 reallyExit 那条关停路时守护进程留成孤儿。
    const d = spawn(options.binary!, serveArgs, { env: { ...environment(), CUA_DRIVER_PARENT_LIVENESS_STDIN: '1' }, stdio: ['pipe', 'pipe', 'pipe'] })
    daemon = d
    // 它的 stdin 只是「咕咕还活着」的凭据:它先退了再关这一头时的 EPIPE 由 exit 那边报,❌ 成了主进程的未捕获异常。
    d.stdin?.on('error', () => undefined)
    d.stdout?.on('data', () => undefined)
    let daemonTail = ''
    let pendingLine = ''
    const diagnostic = (raw: string) => {
      const line = stripVTControlCharacters(raw)
      const nativeAt = line.match(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/)?.[0]
      const time = { at: new Date().toISOString(), ...(nativeAt ? { nativeAt } : {}) }
      const info = line.match(/\bINFO\s+(?:[\w:]+:\s+)?(.*)$/)?.[1]
      const fieldPattern = /\b([a-z_]+)=("(?:[^"\\\n]|\\.)*"|[^\s]+)/g
      if (/\bWARN\s+(?:[\w:]+:\s+)?cursor overlay: no arrival within [\d.]+(?:s|ms); continuing without it\s*$/.test(line)) {
        options.log?.warn({ event: 'cursor_arrival_timeout', ...time }, 'cua-driver cursor arrival timed out')
      } else if (info && info.replace(fieldPattern, '').trim() === 'cua input timing') {
        const fields: Record<string, string | number | boolean> = {}
        // Consume even unknown quoted fields as a unit, so text inside one
        // cannot masquerade as a whitelisted field. Never forward raw lines.
        for (const match of info.matchAll(fieldPattern)) {
          const key = match[1]!
          if (!['tool', 'phase', 'elapsed_ms', 'lock_wait_ms', 'dt_ms', 'arrived', 'session', 'pid', 'window_id'].includes(key)) continue
          const value = match[2]!.replace(/^"|"$/g, '').replace(/^Some\((\d+)\)$/, '$1')
          if (key === 'arrived') {
            if (match[2] === 'true' || match[2] === 'false') fields[key] = match[2] === 'true'
          } else if (['elapsed_ms', 'lock_wait_ms', 'dt_ms', 'pid', 'window_id'].includes(key)) {
            if (/^\d+(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value))) fields[key] = Number(value)
          } else if (/^[\w.:-]{1,256}$/.test(value)) fields[key] = value
        }
        options.log?.info({ event: 'cua_input_timing', ...time, ...fields }, 'cua-driver input timing')
      }
    }
    d.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      daemonTail = (daemonTail + text).slice(-2000)
      pendingLine += text
      let newline
      while ((newline = pendingLine.indexOf('\n')) >= 0) {
        diagnostic(pendingLine.slice(0, newline))
        pendingLine = pendingLine.slice(newline + 1)
      }
      pendingLine = pendingLine.slice(-2000)
    })
    d.on('exit', (code, signal) => {
      if (pendingLine) diagnostic(pendingLine)
      options.log?.info({ code, signal, stderrTail: daemonTail.trim().split('\n').slice(-3).join('\n') }, 'cua-driver serve exited')
      if (daemon === d) shutdown(CRASHED)
    })
    d.on('error', (error) => {
      options.log?.warn({ err: error.message }, 'cua-driver serve failed to start')
      if (daemon === d) shutdown(START_FAILED)
    })
    const ready = waitForSocket(d)
    daemonReady = ready
    ready.catch((error: unknown) => {
      options.log?.warn({ err: String(error) }, 'cua-driver did not start')
      if (daemonReady === ready) shutdown(error instanceof NativeCallError ? error.message : START_FAILED)
    })
    return ready
  }

  /** 一条道的代理:守护进程好了再起,initialize 之后才收调用。它自己退出只关这一条道,❌ 连带别的 agent。 */
  const openLane = (key: string): Lane => {
    const existing = lanes.get(key)
    if (existing) return existing
    // 先起(或认)守护进程,再登记这条道:重起一代时会关掉上一代所有的道,❌ 把这条新的也关了。
    const daemonUp = startDaemon()
    // cua 的会话名归创建它的 transport 所有；旧代理退出后,新代理连 start_session 都不能接回那个名字。
    // lane 的 key 仍归同一个 agent,但每代代理的驱动会话名必须不同(旧快照和元素编号也随之作废)。
    const lane: Lane = { ready: Promise.resolve(null as never), proc: null, session: `${key}-${randomUUID()}`, inflight: 0, settledAt: 0, idle: null }
    lanes.set(key, lane)
    lane.ready = (async () => {
      await daemonUp
      if (lanes.get(key) !== lane) throw new NativeCallError('execution_failed', '电脑控制重新启动了')
      if (platform === 'darwin') {
        const owner = daemon
        const direct = await openCuaDaemonLease({
          socket, owner: `mcp-gugu-${randomUUID()}`, timeoutMs: options.readyTimeoutMs ?? READY_MS,
          ...(options.hostBundleId ? { hostBundleId: options.hostBundleId } : {}),
          onClosed: () => {
            if (lanes.get(key) === lane) closeLane(key, lane, DISCONNECTED)
          },
        })
        if (disposed || lanes.get(key) !== lane || daemon !== owner) {
          direct.close()
          throw new NativeCallError('execution_failed', '电脑控制重新启动了')
        }
        lane.direct = direct
        // The daemon is only a ready marker here; requests use this lane's
        // control lease, never its stdin. A preview can sample that same owner.
        return daemon!
      }
      const p = spawn(options.binary!, ['mcp', '--embedded', '--socket', socket], { env: environment(), stdio: ['pipe', 'pipe', 'pipe'] })
      lane.proc = p
      // 代理先退了、这边还在写(请求、取消通知)的 EPIPE:在途请求由 exit 那边一并拒掉,❌ 成了主进程的未捕获异常。
      p.stdin?.on('error', (error) => options.log?.info({ err: error.message, lane: key }, 'cua-driver mcp stdin closed'))
      const pending: Pending = new Map()
      pendingOf.set(p, pending)
      const lines = readline.createInterface({ input: p.stdout! })
      lines.on('line', (line) => {
        let msg: { id?: unknown; result?: unknown; error?: { message?: unknown } }
        try {
          msg = JSON.parse(line)
        } catch {
          return
        }
        if (typeof msg.id !== 'number') return
        const waiter = pending.get(msg.id)
        if (!waiter) return
        pending.delete(msg.id)
        if (msg.error) waiter.reject(new NativeCallError('execution_failed', String(msg.error.message ?? 'cua-driver 报错')))
        else waiter.resolve(msg.result)
      })
      p.stderr?.on('data', () => undefined)
      p.on('exit', (code, signal) => {
        options.log?.info({ code, signal, lane: key }, 'cua-driver mcp exited')
        failAll(p, new NativeCallError('execution_failed', DISCONNECTED))
        if (lanes.get(key) === lane) closeLane(key, lane, DISCONNECTED)
      })
      p.on('error', (error) => {
        options.log?.warn({ err: error.message, lane: key }, 'cua-driver mcp failed to start')
        failAll(p, new NativeCallError('execution_failed', START_FAILED))
      })
      const readyMs = options.readyTimeoutMs ?? READY_MS
      await within(request(p, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'gugu', version: options.clientVersion },
      }).done, readyMs, () => {
        options.log?.warn({ timeoutMs: readyMs, lane: key }, 'cua-driver mcp did not answer initialize in time')
        return new NativeCallError('execution_failed', START_FAILED)
      })
      write(p, { jsonrpc: '2.0', method: 'notifications/initialized' })
      return p
    })()
    lane.ready.catch((error: unknown) => {
      options.log?.warn({ err: String(error), lane: key }, 'cua-driver lane did not start')
      closeLane(key, lane, error instanceof NativeCallError ? error.message : START_FAILED)
    })
    return lane
  }

  const touch = () => {
    if (idle) clearTimeout(idle)
    idle = setTimeout(() => shutdown('电脑控制闲置太久,已关闭'), IDLE_MS)
    ;(idle as { unref?: () => void }).unref?.()
  }
  const touchLane = (key: string, lane: Lane) => {
    if (lane.idle) clearTimeout(lane.idle)
    lane.idle = setTimeout(() => {
      if (lane.inflight === 0) closeLane(key, lane, '这条电脑控制的连接闲置太久,已关闭')
    }, laneIdleMs)
    ;(lane.idle as { unref?: () => void }).unref?.()
  }

  const send = async (key: string, name: string, args: Record<string, unknown>, callOptions: { signal?: AbortSignal; timeoutMs?: number; remainingMs?: () => number }): Promise<CuaToolResult> => {
    const asked = Date.now()
    const timeoutMs = Math.min(callOptions.timeoutMs ?? 120_000, callOptions.remainingMs?.() ?? Infinity)
    const exhausted = () => new NativeCallError('timeout', `${name} 执行预算已耗尽，本次操作没有发出`)
    if (callOptions.signal?.aborted) throw new NativeCallError('execution_failed', '已取消，本次操作没有发出')
    if (timeoutMs <= 0) throw exhausted()
    const lane = openLane(key)
    const p = await within(lane.ready, timeoutMs,
      () => new NativeCallError('timeout', `电脑控制 ${Math.round(timeoutMs / 1000)} 秒内没能启动,${name} 没有发出去`), callOptions.signal)
    if (disposed || lanes.get(key) !== lane || callOptions.signal?.aborted) throw new NativeCallError('execution_failed', '电脑控制已取消或重新启动，本次操作没有发出')
    const sent = Date.now()
    const left = Math.min(timeoutMs - (sent - asked), callOptions.remainingMs?.() ?? Infinity)
    if (left <= 0) throw exhausted()
    touch()
    touchLane(key, lane)
    lane.inflight += 1
    const forwarded = typeof args.session === 'string' && args.session ? { ...args, session: lane.session } : args
    const { id, done } = lane.direct
      ? { id: 0, done: lane.direct.call(name, forwarded, { signal: callOptions.signal, timeoutMs: left }) }
      : request(p, 'tools/call', { name, arguments: forwarded })
    // 起道用掉的那段也在这一次的时限里。
    let timer: ReturnType<typeof setTimeout> | null = null
    let onAbort: (() => void) | null = null
    const mutation = cuaMutates(name, args)
    // Input cancellation retires only this owner generation. A read must not
    // end a same-owner input, and no cancellation replays an input.
    const cancel = (why: 'timeout' | 'cancelled', error: NativeCallError, reject: (e: Error) => void) => {
      if (!lane.direct) {
        pendingOf.get(p)?.delete(id)
        write(p, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: why } })
      }
      if (mutation) closeLane(key, lane, error.message)
      reject(error)
    }
    try {
      return (await Promise.race([
        done,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => cancel('timeout', new NativeCallError('timeout', `${name} 超过 ${Math.round(timeoutMs / 1000)} 秒没做完；${CUA_CANCEL_UNCONFIRMED}`), reject), left)
          onAbort = () => cancel('cancelled', new NativeCallError('execution_failed', CUA_CANCEL_UNCONFIRMED), reject)
          callOptions.signal?.addEventListener('abort', onAbort, { once: true })
        }),
      ])) as CuaToolResult
    } catch (error) {
      // The direct lease's own timer can reject before this outer timer.
      // Ordinary native refusals are ToolResults, not transport cancellation.
      if (mutation && error instanceof NativeCallError && (error.code === 'timeout' || callOptions.signal?.aborted)) closeLane(key, lane, CUA_CANCEL_UNCONFIRMED)
      throw error
    } finally {
      if (timer) clearTimeout(timer)
      if (onAbort) callOptions.signal?.removeEventListener('abort', onAbort)
      const end = Date.now()
      const before = lane.settledAt
      lane.inflight -= 1
      lane.settledAt = end
      touch()
      if (lanes.get(key) === lane) touchLane(key, lane)
      if (end - asked >= SLOW_MS) {
        // 一条道一次办一个:在它前面的那个回来之前,这个只是在排队(前面那个被这边放弃的话,排队算少了)。
        const waited = Math.max(0, Math.min(before, end) - sent)
        options.log?.warn({ tool: name, lane: key, totalMs: end - asked, startMs: sent - asked, queuedMs: waited, driverMs: end - sent - waited, lanes: lanes.size }, 'cua-driver call was slow')
      }
    }
  }

  /** cua 把这个有名会话结束了(闲置清扫、它所属的道关了):之后的普通调用一律被拒,只有 start_session 能把同名的开回来。 */
  const sessionEnded = (result: CuaToolResult | undefined) =>
    result?.isError === true && (result.content ?? []).some((block) => block.type === 'text' && typeof block.text === 'string' && block.text.includes('session has ended'))

  return {
    async cursorState(session, signal) {
      const lane = lanes.get(session)
      if (!lane || !lane.direct || disposed) return null
      return lane.direct.call('get_agent_cursor_state', { session: lane.session }, { ...(signal ? { signal } : {}), timeoutMs: 2_000 })
    },
    available() {
      if (!options.binary) return { ok: false, message: options.missingMessage }
      if (!fs.existsSync(options.binary)) return { ok: false, message: `${options.missingMessage}(找不到 ${options.binary})` }
      return { ok: true }
    },
    async callTool(name, args, callOptions = {}) {
      // 咕咕在退出:❌ 一个还挂着的页面或 agent 的下一步又把 cua-driver 起回来。
      if (disposed) throw new NativeCallError('execution_failed', '咕咕正在退出,电脑控制已关闭')
      const available = this.available()
      if (!available.ok) throw new NativeCallError('unsupported', available.message)
      if (callOptions.signal?.aborted) throw new NativeCallError('execution_failed', '已取消')
      const askedAt = Date.now()
      const remainingMs = () => Math.max(0, Math.min(
        (callOptions.timeoutMs ?? 120_000) - (Date.now() - askedAt),
        callOptions.remainingMs ? callOptions.remainingMs() - RETURN_RESERVE_MS : Infinity,
      ))
      const budgetOptions = { ...callOptions, remainingMs }
      if (remainingMs() <= 0) throw new NativeCallError('timeout', `${name} 执行预算已耗尽，本次操作没有发出`)
      if (name === 'get_window_state' && args.display_only === true) {
        const closingRead = observations.following(args)
        if (closingRead) return displayOnlyObservation(await within(closingRead, Math.min(remainingMs(), callOptions.timeoutMs ?? 10_000),
          () => new NativeCallError('timeout', '操作后的画面仍在获取中'), callOptions.signal))
      }
      const session = typeof args.session === 'string' && args.session ? args.session : null
      const key = session ?? callOptions.lane ?? ''
      let result = await send(key, name, args, budgetOptions)
      if (session && sessionEnded(result)) {
        const revived = await send(key, 'start_session', { session }, budgetOptions)
        options.log?.info({ tool: name, session, revived: revived?.isError !== true }, 'cua session had ended; started it again')
        if (revived?.isError === true) return result
        result = await send(key, name, args, budgetOptions)
      }
      if (result.isError === true && !(name === 'get_window_state' && needsObservation.has(key) && transientObservationError(result))) return result
      if (result.isError !== true && INPUTS.has(name)) needsObservation.add(key)
      const state = name === 'run_steps' ? batchObservation(result) : null
      const batch = name === 'run_steps' ? batchObservationArgs(result, args) : null
      const subsequentRead = name === 'get_window_state' && args.include_screenshot !== false && args.display_only !== true && needsObservation.has(key)
      if (platform !== 'darwin' || (!batch && !subsequentRead)) return result
      const budgetMs = Math.min(8_000, remainingMs())
      const readArgs = batch ?? args
      const initial: CuaToolResult = batch
        ? { content: result.content?.filter(block => block.type === 'image'), structuredContent: state ?? undefined }
        : result
      const observationStarted = Date.now()
      const fresh = await observations.observe(readArgs, () => settleCuaWindow({
        initial, args: readArgs, budgetMs, sampleImage: options.sampleImage,
        read: (tool, values) => send(key, tool, values, {
          ...budgetOptions,
          timeoutMs: Math.max(0, budgetMs - (Date.now() - observationStarted)),
        }),
      }))
      if (fresh.structuredContent?.observation_stability
        && (fresh.structuredContent.observation_stability as { status?: string }).status === 'stable') needsObservation.delete(key)
      return batch ? replaceBatchObservation(result, fresh) : fresh
    },
    stop: shutdown,
    dispose: () => {
      disposed = true
      shutdown('咕咕退出了')
    },
  }
}
