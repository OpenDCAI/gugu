/**
 * 远程隧道的中转客户端 frpc(fatedier/frp,Apache-2.0;版本与哈希钉在 scripts/frpc-release.json)。两端各跑一个:
 *  · 咕咕 server 的账号进程:把本机的 SSH 端点以 stcp 挂到中转上(tunnel-endpoint.ts);
 *  · 桌面:stcp 访问端,在本机回环上开一个端口,ssh 连它就连到那台机器(tunnel-machines.ts)。
 *
 * 这里只管进程:写配置(0600,含令牌与密钥)、拉起、读日志认出「挂上了 / 掉了 / 被拒」、退出后退避重启、收掉。
 * 认状态只读 frpc 自己打的那几句(`start proxy success`、`start visitor success`、`login to server failed`);
 * 不认识的行原样进日志,❌ 猜。
 */
import type { ChildProcess } from 'node:child_process'
import { execFileSync, spawn } from '@gugu/core/local/childProcess'
import fs from 'node:fs'
import path from 'node:path'
import type { RelayEndpoint } from '@gugu/core/cloud/remoteTunnel'

export type FrpcProxy = { kind: 'proxy'; name: string; secretKey: string; localPort: number }
export type FrpcVisitor = { kind: 'visitor'; name: string; serverUser: string; serverName: string; secretKey: string; bindPort: number }

/** TOML 字符串:只放我们自己生成 / 校验过的值,仍按 TOML 规则转义。纯函数。 */
export function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * 一份 frpc 配置。`loginFailExit = false`:中转一时连不上(网络、frps 重启)frpc 自己按退避重连,
 * ❌ 退出让我们从头拉起;日志打到标准输出,由这里读。纯函数。
 */
export function frpcConfig(input: { relay: RelayEndpoint; user: string; entry: FrpcProxy | FrpcVisitor }): string {
  const lines = [
    `serverAddr = ${tomlString(input.relay.serverAddr)}`,
    `serverPort = ${input.relay.serverPort}`,
    `user = ${tomlString(input.user)}`,
    `auth.token = ${tomlString(input.relay.token)}`,
    // frps 在反向代理后面(443):TLS + WebSocket,出网只要 443(见 core/cloud/remoteTunnel.ts)。
    ...(input.relay.protocol === 'wss' ? ['transport.protocol = "wss"'] : []),
    'loginFailExit = false',
    'log.to = "console"',
    'log.level = "info"',
    'log.disablePrintColor = true',
    '',
  ]
  const entry = input.entry
  if (entry.kind === 'proxy') {
    lines.push(
      '[[proxies]]',
      `name = ${tomlString(entry.name)}`,
      'type = "stcp"',
      `secretKey = ${tomlString(entry.secretKey)}`,
      'localIP = "127.0.0.1"',
      `localPort = ${entry.localPort}`,
    )
  } else {
    lines.push(
      '[[visitors]]',
      `name = ${tomlString(entry.name)}`,
      'type = "stcp"',
      `serverUser = ${tomlString(entry.serverUser)}`,
      `serverName = ${tomlString(entry.serverName)}`,
      `secretKey = ${tomlString(entry.secretKey)}`,
      'bindAddr = "127.0.0.1"',
      `bindPort = ${entry.bindPort}`,
    )
  }
  return `${lines.join('\n')}\n`
}

export type FrpcEvent = 'up' | 'down' | 'rejected'

/**
 * 一行 frpc 日志说了什么:
 *  · up:proxy / visitor 挂上了;
 *  · down:和中转的连接断了(之后它自己重连);
 *  · rejected:中转拒绝了这次登录 / 这个 proxy(令牌不对、名字被占……)—— 重连也没用,如实报。
 * 别的 = null。纯函数。
 */
export function classifyFrpcLine(line: string): FrpcEvent | null {
  if (/start proxy success|start visitor success/.test(line)) return 'up'
  if (/login to (the )?server failed|start error:|proxy .*already exists|authorization failed|token in login doesn't match/i.test(line)) return 'rejected'
  // 实测 0.71.1:frps 没了时访问端先打 `stcp local listener closed`,随后每次重连 `try to connect to server...` +
  // `connect to server error: …`(启动那一句 `try to connect` 也落在这里 —— 那时本来就还没挂上,无害)。
  if (/try to (re)?connect to server|connect to server error|listener closed|session shutdown|work connection closed|control writer is closing/i.test(line)) return 'down'
  return null
}

/** frpc 在哪:环境变量(开发)> 打包版的资源目录 > 应用目录(server 包 / 开发里 `build:frpc` 的产物)。 */
export function frpcCandidates(input: {
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  arch: string
  isPackaged: boolean
  resourcesPath: string | undefined
  appPath: string
}): string[] {
  const exe = input.platform === 'win32' ? 'frpc.exe' : 'frpc'
  const os = input.platform === 'darwin' ? 'mac' : input.platform === 'win32' ? 'win' : 'linux'
  return [
    input.env.GUGU_FRPC_BIN?.trim() || '',
    input.isPackaged && input.resourcesPath ? path.join(input.resourcesPath, 'frpc-bundle', exe) : '',
    path.join(input.appPath, 'frpc-bundle', exe),
    path.join(input.appPath, 'frpc-bundle', `${os}-${input.arch}`, exe),
  ].filter(Boolean)
}

export function findFrpc(candidates: readonly string[], exists: (file: string) => boolean = fs.existsSync): string | null {
  return candidates.find((file) => exists(file)) ?? null
}

/**
 * 上一次没正常收掉的 frpc(账号进程 / 桌面崩了、被 kill -9):按同一份配置文件旁边的 pid 文件找到它,核对它的命令行
 * 里确实是这份配置再收掉 —— ❌ 留着它占着中转上的名字与本机端口,❌ 只看进程号就杀(号会被复用)。
 */
export function killStaleFrpc(
  pidFile: string,
  configFile: string,
  deps: { readCommand?: (pid: number) => string | null; kill?: (pid: number) => void } = {},
): boolean {
  let pid: number
  try {
    pid = Number(fs.readFileSync(pidFile, 'utf8').trim())
  } catch {
    return false
  }
  if (!Number.isInteger(pid) || pid <= 0) return false
  const command = (deps.readCommand ?? readCommand)(pid)
  if (!command || !command.includes(configFile)) return false
  const kill = deps.kill ?? ((target: number) => process.kill(target, 'SIGTERM'))
  try {
    kill(pid)
    return true
  } catch {
    return false
  }
}

function readCommand(pid: number): string | null {
  if (process.platform === 'win32') return null
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null
  } catch {
    return null
  }
}

export type FrpcRunner = {
  /** 此刻挂着没有。 */
  isUp(): boolean
  /** 等它挂上(或等到超时 / 被拒 / 被收掉)。 */
  waitUp(timeoutMs: number): Promise<{ ok: true } | { ok: false; reason: 'timeout' | 'rejected' | 'stopped' | 'spawn'; detail: string }>
  stop(): void
}

const MIN_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 60_000
const TAIL_LINES = 20

export function startFrpc(input: {
  binary: string
  configFile: string
  config: string
  onState?: (up: boolean) => void
  log?: (message: string, fields?: Record<string, unknown>) => void
  spawnFrpc?: (binary: string, args: string[]) => ChildProcess
}): FrpcRunner {
  const log = input.log ?? (() => undefined)
  const pidFile = `${input.configFile}.pid`
  if (killStaleFrpc(pidFile, input.configFile)) log('frpc left over from last run, stopped', { configFile: input.configFile })
  fs.mkdirSync(path.dirname(input.configFile), { recursive: true, mode: 0o700 })
  fs.writeFileSync(input.configFile, input.config, { mode: 0o600 })
  fs.chmodSync(input.configFile, 0o600)

  let child: ChildProcess | null = null
  let up = false
  let stopped = false
  let rejected: string | null = null
  let spawnFailure: string | null = null
  let backoff = MIN_BACKOFF_MS
  let restartTimer: ReturnType<typeof setTimeout> | null = null
  const tail: string[] = []
  const waiters = new Set<() => void>()
  const wake = () => {
    for (const waiter of [...waiters]) waiter()
  }
  const setUp = (next: boolean) => {
    if (up === next) return
    up = next
    if (next) backoff = MIN_BACKOFF_MS
    input.onState?.(next)
    wake()
  }

  const run = () => {
    if (stopped) return
    const proc = (input.spawnFrpc ?? ((bin, args) => spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })))(
      input.binary,
      ['-c', input.configFile],
    )
    child = proc
    if (proc.pid) {
      try {
        fs.writeFileSync(pidFile, `${proc.pid}\n`, { mode: 0o600 })
      } catch {
        // 记不下 = 下次崩了之后收不掉这一个;不挡这次
      }
    }
    let buffer = ''
    const onChunk = (chunk: Buffer | string) => {
      buffer += chunk.toString()
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        tail.push(line)
        if (tail.length > TAIL_LINES) tail.shift()
        const event = classifyFrpcLine(line)
        if (event === 'up') {
          rejected = null
          setUp(true)
        } else if (event === 'down') {
          setUp(false)
        } else if (event === 'rejected') {
          rejected = line.trim()
          log('frpc rejected', { line: line.trim() })
          setUp(false)
          wake()
        }
      }
    }
    proc.stdout?.on('data', onChunk)
    proc.stderr?.on('data', onChunk)
    proc.on('error', (error) => {
      spawnFailure = error.message
      log('frpc spawn failed', { error: error.message })
      wake()
    })
    proc.on('exit', (code, signal) => {
      if (child === proc) child = null
      setUp(false)
      if (stopped) return
      log('frpc exited, restarting', { code, signal, backoffMs: backoff, tail: tail.slice(-3) })
      restartTimer = setTimeout(run, backoff)
      backoff = Math.min(MAX_BACKOFF_MS, backoff * 2)
      wake()
    })
  }
  run()

  return {
    isUp: () => up,
    waitUp(timeoutMs) {
      return new Promise((resolve) => {
        const outcome = (): Awaited<ReturnType<FrpcRunner['waitUp']>> | null => {
          if (up) return { ok: true }
          if (stopped) return { ok: false, reason: 'stopped', detail: 'stopped' }
          if (rejected) return { ok: false, reason: 'rejected', detail: rejected }
          if (spawnFailure) return { ok: false, reason: 'spawn', detail: spawnFailure }
          return null
        }
        const check = (): boolean => {
          const result = outcome()
          if (result) finish(result)
          return result !== null
        }
        const timer = setTimeout(() => finish({ ok: false, reason: 'timeout', detail: tail.slice(-3).join('\n') || 'no output' }), timeoutMs)
        const waiter = () => {
          check()
        }
        function finish(result: Awaited<ReturnType<FrpcRunner['waitUp']>>) {
          clearTimeout(timer)
          waiters.delete(waiter)
          resolve(result)
        }
        if (!check()) waiters.add(waiter)
      })
    },
    stop() {
      if (stopped) return
      stopped = true
      if (restartTimer) clearTimeout(restartTimer)
      child?.kill('SIGTERM')
      child = null
      setUp(false)
      wake()
      try {
        fs.rmSync(input.configFile, { force: true })
        fs.rmSync(pidFile, { force: true })
      } catch {
        // 配置里有令牌与密钥;删不掉也只是一份本用户 0600 的文件
      }
    },
  }
}
