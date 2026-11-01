/**
 * #6264 远程 SSH 的机器:这台桌面与它之间的一切只走 SSH(product spec「两种连法，处处能用」)。
 *
 * 照 VS Code Remote-SSH(本机客户端 ↔ SSH ↔ server 的本机套接字):每台机器一条「设备连接」——
 * 一个常驻的 `ssh -T … exec gugu-server link --account <谁> --adopt-ssh` 子进程,骑在这台机器那条认证过的
 * 共享连接上(ControlMaster,见 ssh-machines.ts / ssh-install/logic.ts)。上面跑的是与咕咕云设备 RPC **逐字相同**的
 * 信封(请求、应答、推送),渲染层的设备 RPC 客户端(src/lib/deviceRpc.ts)只是把「频道」换成它 —— 于是设置、
 * 资源库、已安排、文件、审阅、会话列表与时间线、投递、导入全都走 SSH,❌ 一处一处分叉。
 *
 * 这里只搬字节,不懂业务:主进程 → 那台机器写 M 帧;那台机器 → 主进程的 M 帧原样交给渲染层。
 *
 * 连不上时 ❌ 退回咕咕云:把原因(连不上 / 要先登录 / 那边太旧 / 被拒绝 / 没在跑 / 没登这个账号)如实交回去。
 * 「那边太旧」(outdated,会触发替它升级)只认明确的版本信号(owner 2026-09-25:「升级只能是因为版本问题,
 * 而不是因为连不上」):老版本不认 link 这条命令、账号进程说协议对不上、它报的协议号低于这台桌面要求的。
 * 连不上 / 被拒绝 / 超时 / 说不清的一律照实报,❌ 归成太旧。
 * 后台自己开的连接一律 BatchMode(不弹问):要密码的机器由人点「登录」(signIn)那一下经提问卡片问一次,
 * 之后共享连接一直在,再开设备连接不用再问。
 *
 * 成本:每台用到的机器一个 ssh 子进程(复用共享连接,不另握手);存活靠 ssh 自己的心跳(ServerAliveInterval=5,
 * 连丢 3 次即断),这里 ❌ 轮询。断了不自己重连 —— 由渲染层按「还有没有人在听推送」决定(见 deviceRpc.ts)。
 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawn } from '@gugu/core/local/childProcess'
import {
  encodeJsonFrame,
  FRAME,
  FrameDecoder,
  LINK_EXIT,
  LINK_PROTOCOL_MARK,
  LINK_PROTOCOL_MISMATCH_MARK,
  LINK_READY_MARK,
  parseJson,
} from '../session/main/core/pty/attach/attach-protocol'
import { serverProtocolTooOld } from '@gugu/core/cloud/serverMachineHealth'
import type { SshLinkFailure } from '../../src/lib/sshLink'
import { classifySshFailure, unknownCommandLine, type SshTarget } from './ssh-install/logic'
import { sshBatchArgs } from './ssh-batch'

const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,128}$/

/** 与 electron/server-entry.ts 的「不认识的命令」同一句:那台机器上的 gugu-server 还不认 link。 */
const UNKNOWN_COMMAND = unknownCommandLine('link')

/** 从起进程到那边说「接上了」最多等多久(握手 + 登录 shell 的 rc + 起 CLI)。 */
export const LINK_OPEN_TIMEOUT_MS = 30_000

/** 标记之前的字节(用户 rc 打的横幅)最多留多少:再多就不是我们的协议了。 */
const MAX_PREAMBLE_BYTES = 256 * 1024

export function sshLinkArgs(
  target: SshTarget,
  options: { controlPath: string | null; accountUserId: string; adoptSsh?: boolean },
): string[] {
  if (!ACCOUNT_ID.test(options.accountUserId)) throw new Error('账号 id 形状不对')
  // --adopt-ssh:老机器第一次被装它的那台桌面经 SSH 接上时补记「远程 SSH」。经远程隧道的中转连过去的 ❌ 带它
  // (那会把一台远程隧道的机器记成远程 SSH,设备列表标错、机器上限数错)。
  const adopt = options.adoptSsh === false ? '' : ' --adopt-ssh'
  return sshBatchArgs(target, `exec ~/.local/bin/gugu-server link --account ${options.accountUserId}${adopt}`, options.controlPath)
}

/** 还没接上就结束了:为什么(退出码 + 标准错误最后几行)。纯函数。 */
export function classifyLinkExit(info: { code: number | null; stderr: string }): { reason: SshLinkFailure; detail: string } {
  const detail = info.stderr.trim().split(/\r?\n/).slice(-3).join('\n') || `ssh 退出码 ${String(info.code)}`
  if (info.code === 255) {
    const failure = classifySshFailure(info.stderr)
    // 要人回答(密码 / 口令 / 新主机指纹)才连得上:后台连接不问,交给「登录」那一下。
    if (failure === 'authFailed' || failure === 'hostKeyRejected') return { reason: 'signInRequired', detail }
    if (failure === 'hostKeyChanged') return { reason: 'hostKeyChanged', detail }
    return { reason: 'unreachable', detail }
  }
  // 版本信号只有两种:老版本不认 link 这条命令;账号进程说设备连接协议对不上(退出码 + 标记行,缺一不算)。
  if (info.code === LINK_EXIT.usage && info.stderr.includes(UNKNOWN_COMMAND)) return { reason: 'outdated', detail }
  if (info.code === LINK_EXIT.protocolMismatch && info.stderr.includes(LINK_PROTOCOL_MISMATCH_MARK)) return { reason: 'outdated', detail }
  // 账号进程拒绝了(原因任意):照实报,❌ 当成太旧去升级。
  if (info.code === LINK_EXIT.refused) return { reason: 'refused', detail }
  if (info.code === LINK_EXIT.serverNotRunning) return { reason: 'notRunning', detail }
  if (info.code === LINK_EXIT.notSignedIn) return { reason: 'notSignedIn', detail }
  if (info.code === 127) return { reason: 'notInstalled', detail }
  return { reason: 'unreachable', detail }
}

/**
 * 标准输出上「接上了」之前的那一段:找到标记行,返回它之后的字节(已经是帧)。没找到 = null。
 * 标记前面可能是 rc 打的任何东西(含半行);标记本身由 CLI 打在单独一行上。
 */
export function afterReadyMark(buffer: Buffer): Buffer | null {
  const mark = Buffer.from(`${LINK_READY_MARK}\n`)
  const at = buffer.indexOf(mark)
  return at < 0 ? null : buffer.subarray(at + mark.length)
}

/**
 * 「接上了」之前那一段里 server 报的桌面↔server 协议号(LINK_PROTOCOL_MARK 那一行);老版本不报 = null。纯函数。
 */
export function linkProtocolFromPreamble(preamble: Buffer): number | null {
  const text = preamble.toString('utf8')
  const at = text.lastIndexOf(`${LINK_PROTOCOL_MARK} `)
  if (at < 0) return null
  const line = (text.slice(at + LINK_PROTOCOL_MARK.length + 1).split('\n')[0] ?? '').trim()
  return /^\d{1,6}$/.test(line) ? Number(line) : null
}

/** via = tunnel:经远程隧道的中转连过去的(tunnel-machines.ts),不是这台电脑用远程 SSH 添加的。 */
export type SshLinkMachine = { target: SshTarget; accountUserId: string; via?: 'ssh' | 'tunnel' }

export type SpawnLinkSsh = (args: string[]) => ChildProcessWithoutNullStreams

const systemSpawn: SpawnLinkSsh = (args) => spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] })

type Link = {
  child: ChildProcessWithoutNullStreams
  ready: Promise<{ ok: true } | { ok: false; reason: SshLinkFailure; detail: string }>
  open: boolean
}

export type SshLinkManager = {
  /** 开(或复用)这台机器的设备连接;接上了才回 ok。 */
  open(deviceId: string): Promise<{ ok: true } | { ok: false; reason: SshLinkFailure; detail: string }>
  /** 往这台机器写一条信封;连接没开着 = false(调用方按「断了」处理)。 */
  send(deviceId: string, message: unknown): boolean
  close(deviceId: string): void
  closeAll(): void
  isOpen(deviceId: string): boolean
  /** 此刻开着(或正在开)的那些。 */
  openDeviceIds(): string[]
}

export function createSshLinkManager(options: {
  /** 这台设备怎么连(桌面此刻登着的账号装上的那条映射);没有 = unmapped。 */
  machineFor(deviceId: string): Promise<SshLinkMachine | null>
  controlPath(): string | null
  onMessage(deviceId: string, message: unknown): void
  /** 接上之后断了(ssh 心跳没了、那边重启、被收掉)。主动 close 不报。 */
  onClosed(deviceId: string, failure: { reason: SshLinkFailure; detail: string }): void
  log?: (message: string, fields?: Record<string, unknown>) => void
  spawnSsh?: SpawnLinkSsh
  openTimeoutMs?: number
}): SshLinkManager {
  const links = new Map<string, Link>()
  /** 主动收掉的:断开时 ❌ 报「断了」。 */
  const closing = new WeakSet<Link>()
  const log = options.log ?? (() => undefined)

  const start = (deviceId: string, machine: SshLinkMachine): Link => {
    let args: string[]
    try {
      args = sshLinkArgs(machine.target, {
        controlPath: options.controlPath(),
        accountUserId: machine.accountUserId,
        adoptSsh: machine.via !== 'tunnel',
      })
    } catch (error) {
      const failed = Promise.resolve({ ok: false as const, reason: 'unreachable' as const, detail: (error as Error).message })
      return { child: null as unknown as ChildProcessWithoutNullStreams, ready: failed, open: false }
    }
    const child = (options.spawnSsh ?? systemSpawn)(args)
    let stderr = ''
    let preamble: Buffer | null = Buffer.alloc(0)
    const decoder = new FrameDecoder()
    let settleReady!: (value: Awaited<Link['ready']>) => void
    const ready = new Promise<Awaited<Link['ready']>>((resolve) => {
      settleReady = resolve
    })
    const link: Link = { child, ready, open: false }
    let readySettled = false
    const finishReady = (value: Awaited<Link['ready']>) => {
      if (readySettled) return
      readySettled = true
      clearTimeout(timer)
      link.open = value.ok
      settleReady(value)
    }
    const timer = setTimeout(() => {
      finishReady({ ok: false, reason: 'unreachable', detail: 'timeout' })
      child.kill('SIGTERM')
    }, options.openTimeoutMs ?? LINK_OPEN_TIMEOUT_MS)

    const takeFrames = (chunk: Buffer) => {
      let frames
      try {
        frames = decoder.push(chunk)
      } catch (error) {
        log('ssh link: bad frame, closing', { deviceId, error: String(error) })
        child.kill('SIGTERM')
        return
      }
      for (const frame of frames) {
        if (frame.type !== FRAME.message) continue
        const message = parseJson<unknown>(frame.payload)
        if (message !== null) options.onMessage(deviceId, message)
      }
    }
    child.stdout.on('data', (chunk: Buffer) => {
      if (preamble === null) return takeFrames(chunk)
      preamble = Buffer.concat([preamble, chunk])
      const rest = afterReadyMark(preamble)
      if (!rest) {
        if (preamble.length > MAX_PREAMBLE_BYTES) {
          finishReady({ ok: false, reason: 'unreachable', detail: 'no ready mark' })
          child.kill('SIGTERM')
        }
        return
      }
      // 报了协议号、而且低于这台桌面要求的:明确的版本信号,当太旧收掉(不报 = 老版本,不知道,照常接)。
      const protocol = linkProtocolFromPreamble(preamble.subarray(0, preamble.length - rest.length))
      if (serverProtocolTooOld(protocol, { unknownIsTooOld: false })) {
        finishReady({ ok: false, reason: 'outdated', detail: `server protocol ${String(protocol)}` })
        child.kill('SIGTERM')
        return
      }
      preamble = null
      finishReady({ ok: true })
      if (rest.length) takeFrames(rest)
    })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      if (stderr.length < 16_384) stderr += chunk
    })
    child.stdin.on('error', () => undefined)
    child.on('error', (error) => finishReady({ ok: false, reason: 'unreachable', detail: error.message }))
    child.on('close', (code) => {
      const wasOpen = link.open
      link.open = false
      if (links.get(deviceId) === link) links.delete(deviceId)
      const failure = classifyLinkExit({ code, stderr })
      if (!readySettled) return finishReady({ ok: false, ...failure })
      if (wasOpen && !closing.has(link)) {
        log('ssh link: closed', { deviceId, code, detail: failure.detail })
        options.onClosed(deviceId, failure.reason === 'signInRequired' ? failure : { reason: 'unreachable', detail: failure.detail })
      }
    })
    return link
  }

  return {
    async open(deviceId) {
      const existing = links.get(deviceId)
      if (existing) return existing.ready
      const machine = await options.machineFor(deviceId)
      if (!machine) return { ok: false, reason: 'unmapped', detail: 'no ssh mapping for this device' }
      // 等 machineFor 的时候别处可能已经开了一条。
      const raced = links.get(deviceId)
      if (raced) return raced.ready
      const link = start(deviceId, machine)
      if (!link.child) return link.ready
      links.set(deviceId, link)
      const result = await link.ready
      if (!result.ok) {
        if (links.get(deviceId) === link) links.delete(deviceId)
        log('ssh link: could not open', { deviceId, reason: result.reason, detail: result.detail })
      }
      return result
    },
    send(deviceId, message) {
      const link = links.get(deviceId)
      if (!link?.open) return false
      link.child.stdin.write(encodeJsonFrame(FRAME.message, message))
      return true
    },
    close(deviceId) {
      const link = links.get(deviceId)
      if (!link) return
      links.delete(deviceId)
      closing.add(link)
      link.open = false
      link.child.stdin.end()
      link.child.kill('SIGTERM')
    },
    closeAll() {
      for (const deviceId of [...links.keys()]) this.close(deviceId)
    },
    isOpen: (deviceId) => links.get(deviceId)?.open === true,
    openDeviceIds: () => [...links.keys()],
  }
}
