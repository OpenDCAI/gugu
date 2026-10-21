import crypto from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import type { ChildProcess } from 'node:child_process'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveGuguHome } from '@gugu/core/local/state/paths'
import {
  diskWindowsShimReader,
  escapeCmdCommand,
  escapeCmdShimArgument,
  resolveWindowsNodeScriptLaunch,
  type WindowsShimReader,
} from '@gugu/session-core/exec'
import { onErrorEvent } from '@gugu/session-shared'
import { createLogger } from '../lib/logger'

function codexTransportLogger() {
  return createLogger('sessionpage/codex-app-server-transport')
}

export type CodexAppServerEndpoint =
  | { kind: 'unix'; address: string; socketPath: string }
  | { kind: 'websocket'; address: string; host: string; port: number }

type PrivateDirFs = {
  mkdirSync: typeof mkdirSync
  lstatSync: typeof lstatSync
  chmodSync: typeof chmodSync
}

/**
 * codex app-server 对套接字父目录有硬要求:属于本用户(或 root),且组和其他人不可写 —— 否则直接以
 * 「socket parent must be owned by the user or root and prevent other users from replacing socket entries」退出。
 * 所以:① 目录按用户分(`gugu-cx-<uid>`:/tmp 是整机共用的,一个固定名字会被先来的那个用户占住);
 * ② 以 0700 建,已存在的(旧版本按 0002 umask 建成 0775)收回 0700;③ 是软链或属于别人就不用它。
 */
export function ensurePrivateSocketDir(dir: string, io: PrivateDirFs = { mkdirSync, lstatSync, chmodSync }): boolean {
  try {
    io.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const stat = io.lstatSync(dir)
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return false
    if ((stat.mode & 0o777) !== 0o700) io.chmodSync(dir, 0o700)
    return true
  } catch {
    return false
  }
}

export function codexSocketDir(base: string = tmpdir()): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null
  return join(base, uid === null ? 'gugu-cx' : `gugu-cx-${uid}`)
}

function socketPathFor(key: string): string {
  let dir = codexSocketDir()
  // 按 uid 分的目录被别人抢先占了(软链、别人的目录):换一个现建的私有临时目录。
  if (!ensurePrivateSocketDir(dir)) dir = mkdtempSync(join(tmpdir(), 'gugu-cx-'))
  const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 16)
  return join(dir, `cx-${hash}.sock`)
}

function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('无法为 Codex app-server 分配 loopback 端口'))
        return
      }
      server.close((error) => {
        if (error) reject(error)
        else resolve(address.port)
      })
    })
  })
}

/**
 * `sessionKey` 必须逐**会话**唯一,不能只按 agent 取:start() 会无条件 unlink 自己这条 sock、dispose 也
 * 只删自己这条,两处都以「这条路径归我一个会话」为前提。按 agent 取时,同一 agent 的第二条会话会掀掉
 * 第一条的 sock(而第一条的 app-server 还活着、TUI 还连着),第一条 dispose 时又反过来删第二条的。
 */
export async function createCodexAppServerEndpoint(
  sessionKey: string,
  platform: NodeJS.Platform
): Promise<CodexAppServerEndpoint> {
  if (platform === 'win32') {
    const host = '127.0.0.1'
    const port = await reserveLoopbackPort()
    return { kind: 'websocket', address: `ws://${host}:${port}`, host, port }
  }
  const socketPath = socketPathFor(sessionKey)
  return { kind: 'unix', address: `unix://${socketPath}`, socketPath }
}

export function removeCodexAppServerEndpoint(endpoint: CodexAppServerEndpoint | null): void {
  if (endpoint?.kind !== 'unix') return
  try {
    rmSync(endpoint.socketPath, { force: true })
  } catch {
    /* noop */
  }
}

function probeWebSocketReadiness(endpoint: CodexAppServerEndpoint): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (ready: boolean) => {
      if (settled) return
      settled = true
      resolve(ready)
    }
    const request = http.request(
      {
        ...(endpoint.kind === 'unix'
          ? { socketPath: endpoint.socketPath }
          : { host: endpoint.host, port: endpoint.port }),
        path: '/rpc',
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
          'Sec-WebSocket-Version': '13'
        }
      },
      (response) => {
        response.resume()
        finish(false)
      }
    )
    request.once('upgrade', (response, socket) => {
      socket.destroy()
      finish(response.statusCode === 101)
    })
    request.setTimeout(500, () => {
      request.destroy()
      finish(false)
    })
    request.once('error', () => finish(false))
    request.end()
  })
}

/** #6264 一次就绪探测(对 /rpc 做一次 WS 升级):接回 tmux 里那台 app-server 之前,先证明它真在这个地址上应答。 */
export function probeCodexAppServerEndpoint(endpoint: CodexAppServerEndpoint): Promise<boolean> {
  return probeWebSocketReadiness(endpoint)
}

/**
 * app-server 进程在端点就绪之前自己退出了:这是 codex 那一侧的事(它的 stderr 说明原因),起任务失败照原话递(#7103)。
 * 不改 `name`:与普通 Error 一样打印,别处的日志 / 原文一字不变。
 */
export class CodexAppServerExitedError extends Error {}

/**
 * #6264 `waitForCodexAppServerEndpoint` 的 tmux 版:引擎不是本进程的子进程,没有 exit 事件可等 ——
 * 改为每次探测落空后问一次「它还活着吗」(一次 kill(pid, 0)),死了当场失败,❌ 等满超时。
 */
export async function waitForCodexAppServerEndpointWhileAlive(
  endpoint: CodexAppServerEndpoint,
  isAlive: () => boolean,
  timeoutMs = 15_000,
): Promise<void> {
  const start = Date.now()
  let pollDelayMs = 20
  for (;;) {
    if (await probeWebSocketReadiness(endpoint)) return
    if (!isAlive()) throw new CodexAppServerExitedError('codex app-server exited before endpoint ready (tmux-hosted)')
    if (Date.now() - start > timeoutMs) {
      throw new Error(`codex app-server endpoint 未在 ${timeoutMs}ms 内就绪: ${endpoint.address}`)
    }
    await new Promise<void>((resolve) => setTimeout(resolve, pollDelayMs))
    pollDelayMs = Math.min(pollDelayMs * 2, 150)
  }
}

/** #6264 把记在 tmux 会话上的地址还原成端点(接回时用)。认不出 → null。 */
export function parseCodexAppServerEndpoint(address: string): CodexAppServerEndpoint | null {
  if (address.startsWith('unix://')) {
    const socketPath = address.slice('unix://'.length)
    return socketPath ? { kind: 'unix', address, socketPath } : null
  }
  const ws = address.match(/^ws:\/\/([^:/]+):(\d+)$/)
  if (ws) return { kind: 'websocket', address, host: ws[1]!, port: Number(ws[2]) }
  return null
}

export function waitForCodexAppServerEndpoint(
  endpoint: CodexAppServerEndpoint,
  child: ChildProcess,
  timeoutMs = 15_000
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const cleanup = () => {
      if (timer) clearTimeout(timer)
      child.off('error', onError)
      child.off('exit', onExit)
      // @@@unhandled-error-event (#4942) — 为什么摘完还要数一遍监听者:onError 是**一次性**的握手 handler,
      // 摘掉它本身是对的(不摘就泄漏一个会 reject 已 settle 的 Promise 的闭包)。但摘完若一个监听者都不剩,
      // 这条长驻引擎进程此后整个生命周期都没有 'error' 出口,而 Node 对没人接的 'error' 一视同仁地抛成
      // 未捕获异常 —— 在会话页宿主里等于宿主连同所有会话一起死。这类失败是异步的,调用点的 try/catch 接不住。
      // spawn 处已经挂了终身出口(见 codex-app-server-delivery),这里只是把那条不变量变成**被强制的**:
      // 计数为 0 说明调用者没挂,当场补一条,而不是靠注释约定。❌ 不是吞错:错误照旧落日志报出去。
      if (child.listenerCount('error') === 0) {
        onErrorEvent(child, (error) => {
          codexTransportLogger().error({ pid: child.pid, err: error.message }, 'codex app-server child process error')
        })
      }
    }
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      cleanup()
      callback()
    }
    const onError = (error: Error) => finish(() => reject(error))
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(() =>
        reject(
          new CodexAppServerExitedError(`codex app-server exited before endpoint ready (code=${code} signal=${signal})`)
        )
      )
    }
    child.once('error', onError)
    child.once('exit', onExit)
    let pollDelayMs = 20
    const tick = async () => {
      if (settled) return
      if (await probeWebSocketReadiness(endpoint)) return finish(resolve)
      if (settled) return
      if (Date.now() - start > timeoutMs) {
        return finish(() =>
          reject(
            new Error(`codex app-server endpoint 未在 ${timeoutMs}ms 内就绪: ${endpoint.address}`)
          )
        )
      }
      // 启动提速 —— 20 / 40 / 80 / 150 / 150 … ms:引擎通常在几百毫秒内就绪,固定 150ms 的
      // 格子平均白等 75ms;退避后早期探得密、后期不刷屏。
      timer = setTimeout(() => void tick(), pollDelayMs)
      pollDelayMs = Math.min(pollDelayMs * 2, 150)
    }
    void tick()
  })
}

export interface CodexAppServerSpawn {
  command: string
  args: string[]
  windowsVerbatimArguments?: boolean
}

// cmd.exe 会先解析一次，npm 风格 batch shim 的 `%*` 再转发一次 —— 两层转义的那份算法现在
// 收在 `@gugu/session-core/exec` 的 windows-launcher 里，探测路与这条路共用同一份（#5719）。

/** Resolve a Windows launcher into an argv-only child_process spawn. */
export function resolveCodexAppServerSpawn(
  codexBin: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  shimReader: WindowsShimReader = diskWindowsShimReader
): CodexAppServerSpawn {
  if (platform !== 'win32' || /\.(?:com|exe)$/i.test(codexBin)) {
    return { command: codexBin, args }
  }
  if (/\.ps1$/i.test(codexBin)) {
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', codexBin, ...args]
    }
  }

  const nodeLaunch = resolveWindowsNodeScriptLaunch(codexBin, { platform, reader: shimReader })
  if (nodeLaunch) {
    return { command: nodeLaunch.node, args: [nodeLaunch.entry, ...args] }
  }

  const commandLine = [escapeCmdCommand(codexBin), ...args.map(escapeCmdShimArgument)].join(' ')
  return {
    command: env.ComSpec ?? env.COMSPEC ?? 'C:\\Windows\\System32\\cmd.exe',
    args: ['/d', '/s', '/c', `"${commandLine}"`],
    windowsVerbatimArguments: true
  }
}

export async function removeRetiredCodexCapabilityRuns(
  env: NodeJS.ProcessEnv = process.env
): Promise<{ found: number; removed: number }> {
  const root = join(resolveGuguHome(env), 'runtime-sessions', 'codex-capability-runs')
  let entries: string[]
  try {
    entries = await readdir(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { found: 0, removed: 0 }
    throw error
  }
  await rm(root, { recursive: true, force: true })
  return { found: entries.length, removed: entries.length }
}

export function waitForCodexAppServerProcessClose(
  proc: ChildProcess,
  timeoutMs = 500
): Promise<{ status: 'closed' } | { status: 'timed-out'; timeoutMs: number }> {
  if ((proc.exitCode !== null || proc.signalCode !== null) && proc.stderr?.readableEnded) {
    return Promise.resolve({ status: 'closed' })
  }
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => finish({ status: 'timed-out', timeoutMs }), timeoutMs)
    function finish(result: { status: 'closed' } | { status: 'timed-out'; timeoutMs: number }): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      proc.off('close', onClose)
      resolve(result)
    }
    const onClose = () => finish({ status: 'closed' })
    proc.once('close', onClose)
  })
}

const STDERR_TAIL_LIMIT = 8 * 1024

export function appendCodexStderrTail(current: string, chunk: unknown): string {
  const combined = current + String(chunk)
  return combined.length > STDERR_TAIL_LIMIT ? combined.slice(-STDERR_TAIL_LIMIT) : combined
}
