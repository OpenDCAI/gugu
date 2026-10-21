/**
 * 远程隧道 · 桌面这一头(那台机器那一头见 tunnel-endpoint.ts,整体说明见 packages/core/src/cloud/remoteTunnel.ts)。
 *
 * 「只经咕咕云连着」的机器(远程隧道、云电脑、别的电脑用远程 SSH 添加的)报了中转通着(capabilities.tunnel_relay),
 * 渲染层就把它们交给这里(want)。对每一台:
 *  1. 经咕咕云的设备频道问它 `tunnel.open`,交上这台电脑那把咕咕钥匙的公钥 → 拿回中转坐标、stcp 密钥、主机公钥;
 *  2. 起一个 frpc 访问端,在本机回环上开一个端口;
 *  3. ssh 经这个端口连过去(只用咕咕钥匙、只认它报的主机公钥、不读用户的 ~/.ssh/config),建好共享连接;
 *  4. 连上了才算「通了」:之后它与远程 SSH 的机器同一套 —— 设备连接(ssh-link.ts)、端口转发(浏览器 / 端口)都拿这里给的 SshTarget。
 * 任何一步不成:记下原因(界面照实说),退避重试;❌ 退回把终端画面塞进咕咕云的消息通道。
 *
 * 成本:每台通着的机器一个 frpc 进程 + 一条 ssh 共享连接;只在渲染层要(那台机器在线且中转通着)时才建。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import {
  parseTunnelOpenResponse,
  TUNNEL_OPEN_RPC_TYPE,
  type TunnelOpenResponse,
} from '@gugu/core/cloud/remoteTunnel'
import type { DeviceRpcResponse } from '@gugu/core/cloud/deviceRpcProtocol'
import { frpcConfig, startFrpc, type FrpcRunner } from './frpc-runner'
import { buildEnsureMasterArgs, buildMuxControlArgs, type SshTarget } from './ssh-install/logic'
import { sshBatchArgs } from './ssh-batch'
import type { TunnelProblem, TunnelState } from '../../src/lib/tunnelMachines'

const ID = /^[A-Za-z0-9_-]{1,128}$/

/** 问 tunnel.open 最多等多久:那台机器的 frpc 可能还在连中转(它那头最多等 15 秒)。 */
const OPEN_RPC_TIMEOUT_MS = 25_000
/** frpc 访问端挂上中转最多等多久。 */
const VISITOR_UP_TIMEOUT_MS = 20_000
/** ssh 经中转握手 + 认证最多等多久。 */
const SSH_READY_TIMEOUT_MS = 30_000
const RETRY_MIN_MS = 5_000
const RETRY_MAX_MS = 5 * 60_000

export type { TunnelProblem, TunnelState }

/** 设备 id → known_hosts 里用的名字(HostKeyAlias):与任何真实主机名都撞不上。 */
export function tunnelHostAlias(deviceId: string): string {
  return `gugu-tunnel-${deviceId}`
}

/** known_hosts 里换掉(或加上)这台机器那一行,别的行原样留着。纯函数。 */
export function upsertKnownHost(text: string, alias: string, hostKey: string): string {
  const lines = text.split('\n').filter((line) => line.trim() && line.split(/\s+/)[0] !== alias)
  lines.push(`${alias} ${hostKey}`)
  return `${lines.join('\n')}\n`
}

/** ssh 选项值里带空格的路径要加引号(OpenSSH 按空白切值)。路径里有引号 / 换行就不收。纯函数。 */
export function quotedOptionPath(file: string): string {
  if (/["\r\n]/.test(file)) throw new Error('路径里有引号或换行')
  return `"${file}"`
}

/**
 * 经中转连这台机器的 SshTarget。`-F none`:不读用户自己的 ~/.ssh/config —— 那里的 `Host *`(跳板、代理命令、别的钥匙)
 * 套到 127.0.0.1 上只会连错;只用咕咕钥匙、只认它报的主机公钥、不问密码。纯函数。
 */
export function tunnelSshTarget(input: {
  deviceId: string
  label: string
  sshUser: string
  localPort: number
  keyPath: string
  knownHostsFile: string
}): SshTarget {
  return {
    destination: `${input.sshUser}@127.0.0.1`,
    port: input.localPort,
    display: input.label,
    options: [
      '-F', 'none',
      '-i', input.keyPath,
      '-o', 'IdentitiesOnly=yes',
      '-o', 'PreferredAuthentications=publickey',
      '-o', 'PasswordAuthentication=no',
      '-o', 'KbdInteractiveAuthentication=no',
      '-o', `HostKeyAlias=${tunnelHostAlias(input.deviceId)}`,
      '-o', `UserKnownHostsFile=${quotedOptionPath(input.knownHostsFile)}`,
      '-o', 'StrictHostKeyChecking=yes',
      '-o', 'CheckHostIP=no',
    ],
  }
}

/** 本机回环上一个此刻空着的端口(给 frpc 访问端绑)。 */
export function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => (port ? resolve(port) : reject(new Error('拿不到空端口'))))
    })
  })
}

/** tunnel.open 的应答(或失败)→ 原因码。纯函数。 */
export function classifyOpenFailure(response: DeviceRpcResponse<unknown> | null): TunnelProblem {
  const code = response?.error?.code
  if (code === 'relay_down') return 'relayDown'
  if (code === 'unknown_method' || code === 'tunnel_unavailable' || code === 'invalid_payload') return 'unsupported'
  return 'unreachable'
}

type Tunnel = {
  deviceId: string
  label: string
  /** 正在建 / 已建好的那一次;再来一次前先收掉它。 */
  frpc: FrpcRunner | null
  target: SshTarget | null
  accountUserId: string | null
  ready: boolean
  establishing: boolean
  retryTimer: ReturnType<typeof setTimeout> | null
  retryDelay: number
}

export type TunnelMachines = {
  /** 渲染层给的:此刻要通的那些机器(在线、中转通着、这台电脑没有它的 SSH 映射)。不在单子上的收掉。 */
  want(devices: ReadonlyArray<{ deviceId: string; label: string }>): void
  state(): TunnelState
  onChange(listener: (state: TunnelState) => void): () => void
  /** 通着的这台怎么连(设备连接、端口转发用);没通 = null。 */
  linkMachine(deviceId: string): { target: SshTarget; accountUserId: string } | null
  /** 设备连接 / 转发发现这条路断了:重建。 */
  reportBroken(deviceId: string): void
  closeAll(): void
}

export function createTunnelMachines(deps: {
  /** 桌面此刻登着的账号;没登录 = 不建。 */
  currentUserId(): Promise<string | null>
  /** 经咕咕云(❌ 经设备连接 —— 那条正是要建的东西)问那台机器。 */
  callCloud(deviceId: string, type: string, payload: unknown, timeoutMs: number): Promise<DeviceRpcResponse<unknown>>
  /** 这台电脑那把咕咕钥匙(没有就建一把)。 */
  ensureKey(): Promise<{ keyPath: string; publicKey: string }>
  frpcBinary(): string | null
  /** 放 frpc 配置、known_hosts 的目录(只有本用户进得去)。 */
  stateDir(): string
  controlPath(): string | null
  log(message: string, fields?: Record<string, unknown>): void
  /** 单测替身。 */
  runSsh?: (args: string[], timeoutMs: number) => Promise<{ code: number | null; stderr: string }>
  startFrpc?: typeof startFrpc
  freePort?: () => Promise<number>
}): TunnelMachines {
  const tunnels = new Map<string, Tunnel>()
  const problems = new Map<string, TunnelProblem>()
  const listeners = new Set<(state: TunnelState) => void>()
  let wanted = new Set<string>()

  const snapshot = (): TunnelState => ({
    ready: [...tunnels.values()].filter((t) => t.ready).map((t) => t.deviceId),
    problems: Object.fromEntries(problems),
  })
  let last = JSON.stringify(snapshot())
  const emit = () => {
    const next = snapshot()
    const text = JSON.stringify(next)
    if (text === last) return
    last = text
    for (const listener of [...listeners]) listener(next)
  }

  const runSsh = deps.runSsh ?? ((args, timeoutMs) => new Promise((resolve) => {
    const child = spawn('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    let stderr = ''
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      if (stderr.length < 16_384) stderr += chunk
    })
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: null, stderr: error.message })
    })
    // 'exit' 而不是 'close':建共享连接时 ssh 把 master 放到后台(ControlPersist),它还拿着标准错误 ——
    // 等 'close' 就要等到那条连接收掉(与 port-forward.ts 同一个原因)。
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, stderr })
    })
  }))

  const teardown = (tunnel: Tunnel) => {
    const target = tunnel.target
    const controlPath = deps.controlPath()
    if (target && controlPath) void runSsh(buildMuxControlArgs(target, controlPath, 'exit'), 5_000)
    tunnel.frpc?.stop()
    tunnel.frpc = null
    tunnel.target = null
    tunnel.ready = false
  }

  // 这一次建连还算数:登记表里仍是这个对象、仍在要连的单子上。掉出去又回来的那台是新对象 ——
  // 旧的那次每过一个 await 都要核对,不算数就收掉自己(❌ 只比设备 id:两次建连会共用同一份 frpc 配置,
  // 旧的连通了也没人收得到)。
  const current = (tunnel: Tunnel) => tunnels.get(tunnel.deviceId) === tunnel && wanted.has(tunnel.deviceId)

  const scheduleRetry = (tunnel: Tunnel) => {
    if (tunnel.retryTimer || !current(tunnel)) return
    tunnel.retryTimer = setTimeout(() => {
      tunnel.retryTimer = null
      void establish(tunnel)
    }, tunnel.retryDelay)
    tunnel.retryDelay = Math.min(RETRY_MAX_MS, tunnel.retryDelay * 2)
  }

  const fail = (tunnel: Tunnel, problem: TunnelProblem, detail: string) => {
    teardown(tunnel)
    if (!current(tunnel)) return
    deps.log('tunnel: could not connect', { deviceId: tunnel.deviceId, problem, detail })
    problems.set(tunnel.deviceId, problem)
    emit()
    scheduleRetry(tunnel)
  }

  const establish = async (tunnel: Tunnel): Promise<void> => {
    if (tunnel.establishing || !current(tunnel)) return
    tunnel.establishing = true
    try {
      teardown(tunnel)
      const userId = await deps.currentUserId()
      if (!current(tunnel)) return
      // 登录态还没就绪 / 正在刷新凭证:过一会儿再试(❌ 一声不吭地停在「正在连接」)。
      if (!userId) {
        deps.log('tunnel: not signed in yet, retrying', { deviceId: tunnel.deviceId })
        return scheduleRetry(tunnel)
      }
      const binary = deps.frpcBinary()
      if (!binary) return fail(tunnel, 'local', '这台电脑的咕咕里缺 frpc')
      let key: { keyPath: string; publicKey: string }
      try {
        key = await deps.ensureKey()
      } catch (error) {
        return fail(tunnel, 'local', (error as Error).message)
      }
      if (!current(tunnel)) return
      let response: DeviceRpcResponse<unknown>
      try {
        response = await deps.callCloud(tunnel.deviceId, TUNNEL_OPEN_RPC_TYPE, { publicKey: key.publicKey }, OPEN_RPC_TIMEOUT_MS)
      } catch (error) {
        return fail(tunnel, 'unreachable', (error as Error).message)
      }
      const open: TunnelOpenResponse | null = response.error ? null : parseTunnelOpenResponse(response.result)
      if (!open) return fail(tunnel, classifyOpenFailure(response), response.error?.message ?? 'tunnel.open 的应答形状不对')
      // 那台机器登的必须是此刻这个人(换号那一瞬的应答 ❌ 拿来连)。
      if (open.relay.user !== userId) return fail(tunnel, 'unsupported', '那台机器登的不是这个账号')
      if (!current(tunnel)) return

      const dir = deps.stateDir()
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      const knownHostsFile = path.join(dir, 'tunnel_known_hosts')
      const alias = tunnelHostAlias(tunnel.deviceId)
      let known = ''
      try {
        known = fs.readFileSync(knownHostsFile, 'utf8')
      } catch {
        // 第一台
      }
      fs.writeFileSync(knownHostsFile, upsertKnownHost(known, alias, open.hostKey), { mode: 0o600 })

      const localPort = await (deps.freePort ?? freeLoopbackPort)()
      if (!current(tunnel)) return
      const frpc = (deps.startFrpc ?? startFrpc)({
        binary,
        configFile: path.join(dir, `frpc-${tunnel.deviceId}.toml`),
        config: frpcConfig({
          relay: open.relay,
          user: userId,
          entry: {
            kind: 'visitor',
            name: `visit-${tunnel.deviceId}`.slice(0, 128),
            serverUser: open.relay.user,
            serverName: open.relay.serverName,
            secretKey: open.relay.secretKey,
            bindPort: localPort,
          },
        }),
        onState: (up) => {
          // 中转断了:这条路不通了,重建(frpc 自己也在重连;重建时会重新问一次 tunnel.open —— 那台机器可能已经换了密钥)。
          if (!up && tunnel.frpc === frpc && tunnel.ready) {
            tunnel.ready = false
            problems.set(tunnel.deviceId, 'visitorFailed')
            emit()
            scheduleRetry(tunnel)
          }
        },
        log: (message, fields) => deps.log(message, { deviceId: tunnel.deviceId, ...fields }),
      })
      tunnel.frpc = frpc
      const up = await frpc.waitUp(VISITOR_UP_TIMEOUT_MS)
      if (!up.ok) return fail(tunnel, 'visitorFailed', `${up.reason}: ${up.detail}`)
      if (!current(tunnel)) return teardown(tunnel)

      const target = tunnelSshTarget({
        deviceId: tunnel.deviceId,
        label: tunnel.label,
        sshUser: open.sshUser,
        localPort,
        keyPath: key.keyPath,
        knownHostsFile,
      })
      tunnel.target = target
      // 共享连接建好 = 真的通了(握手 + 主机公钥 + 钥匙都过了)。没有共享连接(Windows)就连一次跑个 exit 0。
      const controlPath = deps.controlPath()
      const args = controlPath
        ? ['-o', 'BatchMode=yes', ...buildEnsureMasterArgs(target, controlPath)]
        : sshBatchArgs(target, 'exit 0', null)
      const ssh = await runSsh(args, SSH_READY_TIMEOUT_MS)
      if (ssh.code !== 0) return fail(tunnel, 'sshFailed', ssh.stderr.trim().split('\n').slice(-2).join(' ') || `ssh 退出码 ${String(ssh.code)}`)
      if (!current(tunnel)) return teardown(tunnel)
      tunnel.accountUserId = open.relay.user
      tunnel.ready = true
      tunnel.retryDelay = RETRY_MIN_MS
      problems.delete(tunnel.deviceId)
      deps.log('tunnel: connected', { deviceId: tunnel.deviceId, localPort })
      emit()
    } catch (error) {
      fail(tunnel, 'local', (error as Error).message)
    } finally {
      tunnel.establishing = false
    }
  }

  const drop = (deviceId: string) => {
    const tunnel = tunnels.get(deviceId)
    if (!tunnel) return
    if (tunnel.retryTimer) clearTimeout(tunnel.retryTimer)
    teardown(tunnel)
    tunnels.delete(deviceId)
    problems.delete(deviceId)
  }

  return {
    want(devices) {
      const next = new Set(devices.filter((d) => ID.test(d.deviceId)).map((d) => d.deviceId))
      wanted = next
      for (const deviceId of [...tunnels.keys()]) if (!next.has(deviceId)) drop(deviceId)
      for (const device of devices) {
        if (!ID.test(device.deviceId)) continue
        const existing = tunnels.get(device.deviceId)
        if (existing) {
          existing.label = device.label
          continue
        }
        const tunnel: Tunnel = {
          deviceId: device.deviceId,
          label: device.label,
          frpc: null,
          target: null,
          accountUserId: null,
          ready: false,
          establishing: false,
          retryTimer: null,
          retryDelay: RETRY_MIN_MS,
        }
        tunnels.set(device.deviceId, tunnel)
        void establish(tunnel)
      }
      emit()
    },
    state: snapshot,
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    linkMachine(deviceId) {
      const tunnel = tunnels.get(deviceId)
      return tunnel?.ready && tunnel.target && tunnel.accountUserId ? { target: tunnel.target, accountUserId: tunnel.accountUserId } : null
    },
    reportBroken(deviceId) {
      const tunnel = tunnels.get(deviceId)
      if (!tunnel || tunnel.establishing) return
      tunnel.ready = false
      emit()
      void establish(tunnel)
    },
    closeAll() {
      wanted = new Set()
      for (const deviceId of [...tunnels.keys()]) drop(deviceId)
      emit()
    },
  }
}
