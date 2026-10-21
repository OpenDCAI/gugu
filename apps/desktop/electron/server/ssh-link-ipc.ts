/**
 * #6264 设备连接(ssh-link.ts)接到渲染层:open / send / close,以及人点「登录」那一下(signIn)。
 * 契约见 src/lib/sshLink.ts。
 *
 * signIn:后台开的设备连接一律不弹问(BatchMode);要密码 / 口令 / 新主机指纹的机器,由人点「登录」,
 * 这里用与直连终端同一套 askpass + 提问卡片问一次,登上后共享连接一直留着(ControlPersist),再开设备连接不再问。
 * 密码提问上照样给「以后连这台机器不用再输密码」(下次免密,见 ssh-key-install.ts)。
 */
import { spawn } from 'node:child_process'
import type { BrowserWindow } from 'electron'
import {
  SSH_LINK_CHANNELS,
  type SshLinkAnswer,
  type SshLinkFailure,
  type SshLinkOpenResult,
  type SshUpgradeEvent,
} from '../../src/lib/sshLink'
import type { SshKeyInstallOutcome } from '../../src/session/shared/ssh-prompt'
import type { DirectTerminalAskpass } from '../session/main/core/pty/direct-terminal/ssh-connect'
import { desktopReportId, REMOTE_PROTOCOL_VERSION } from '@gugu/core/cloud/serverMachineHealth'
import { reportedDesktopVersion } from '@gugu/core/cloud/serverDesktopVersions'
import { createSshAutoUpgrader, sshServerUpgradeRunner, type SshAutoUpgrader } from './ssh-install/auto-upgrade'
import { buildEnsureMasterArgs, classifySshFailure, type SshTarget } from './ssh-install/logic'
import { systemSpawnSsh } from './ssh-install/system'
import type { SharedSshLinks } from '../device-rpc-requester'
import { createSshLinkManager, type SshLinkManager } from './ssh-link'
import { findSshMachine, sshTargetOf, terminalControlPath, type SshMachine, type SshMachineStore } from './ssh-machines'
import { createTerminalAskpass } from './ssh-prompts'

const ID = /^[A-Za-z0-9_-]{1,128}$/

/** 与会话页「下次免密」提示同一条事件(src/session/shared/ssh-key-install.ts)。 */
const KEY_INSTALL_EVENT = 'ssh-key-install:done'

/**
 * 设备连接开不起来的原因交给渲染层之前:太旧的,这台桌面够得着就当场替它升级,报「正在更新」;
 * 冷却中 / 没有升级器 = 如实报太旧。纯函数(升级器注入)。
 */
export function openOutcome(
  deviceId: string,
  result: { ok: true } | { ok: false; reason: SshLinkFailure },
  upgrader: Pick<SshAutoUpgrader, 'request'> | null,
): SshLinkOpenResult {
  if (result.ok) return result
  if (result.reason === 'outdated' && upgrader?.request(deviceId)) return { ok: false, reason: 'updating' }
  return { ok: false, reason: result.reason }
}

/** 登录那一下的 ssh 结束了:成没成、没成为什么。纯函数。 */
export function classifySignInExit(code: number | null, stderr: string): { ok: true } | { ok: false; reason: SshLinkFailure } {
  if (code === 0) return { ok: true }
  const failure = classifySshFailure(stderr)
  if (failure === 'authFailed' || failure === 'hostKeyRejected') return { ok: false, reason: 'signInRequired' }
  if (failure === 'hostKeyChanged') return { ok: false, reason: 'hostKeyChanged' }
  return { ok: false, reason: 'unreachable' }
}

export function registerSshLinkIpc(options: {
  ipcMain: Electron.IpcMain
  getWindow: () => BrowserWindow | null
  store: SshMachineStore
  currentUserId: () => Promise<string | null>
  installKey?: (machine: SshMachine, controlPath: string | null, password: string) => Promise<SshKeyInstallOutcome>
  log?: (message: string, fields?: Record<string, unknown>) => void
  /** 太旧时替它升级装哪条通道(与桌面自己的更新通道一致);不给 = 不替它升级(只报太旧)。 */
  upgradeChannel?: 'stable' | 'beta'
  /** 单测替身;默认按 upgradeChannel 真升。 */
  upgrader?: SshAutoUpgrader
  /**
   * #6264 这台桌面的设备 id(与开窗口时报给那台机器的同一个,见 src/lib/remoteSessionHost.ts):替它换成和这台桌面
   * 匹配的那一版时报给它。拿不到就只能整台升级(老路)。
   */
  desktopId?: () => Promise<string | null>
  /**
   * 远程隧道:这台电脑没有它的 SSH 映射、但经中转连通了的机器(tunnel-machines.ts)。设备连接照样开在它上面;
   * 不替它升级(它自己经咕咕云升级)、不问登录(只用咕咕钥匙)。
   */
  tunnels?: { linkMachine(deviceId: string): { target: SshTarget; accountUserId: string } | null; reportBroken(deviceId: string): void }
}): SshLinkManager & SharedSshLinks {
  const send = (channel: string, payload: unknown) => {
    const win = options.getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }
  const machineFor = async (deviceId: string): Promise<SshMachine | null> => {
    const userId = (await options.currentUserId().catch(() => null)) ?? null
    return userId ? findSshMachine(options.store.list(), deviceId, userId) : null
  }
  // 同一条连接,窗口之外主进程也在用(agent 的 session_* 跨机器,main.ts):它们按机器挂在这里,❌ 各开一条。
  const taps = new Map<string, Set<Parameters<SharedSshLinks['tap']>[1]>>()
  const links = createSshLinkManager({
    machineFor: async (deviceId) => {
      const machine = await machineFor(deviceId)
      if (machine) return { target: sshTargetOf(machine), accountUserId: machine.ownerUserId }
      const tunnel = options.tunnels?.linkMachine(deviceId)
      return tunnel ? { ...tunnel, via: 'tunnel' } : null
    },
    controlPath: terminalControlPath,
    onMessage: (deviceId, message) => {
      send(SSH_LINK_CHANNELS.message, { deviceId, message })
      for (const tap of [...(taps.get(deviceId) ?? [])]) tap.onMessage(message)
    },
    onClosed: (deviceId, failure) => {
      const viaTunnel = !!options.tunnels?.linkMachine(deviceId)
      send(SSH_LINK_CHANNELS.closed, { deviceId, reason: failure.reason, ...(viaTunnel ? { via: 'tunnel' } : {}) })
      for (const tap of [...(taps.get(deviceId) ?? [])]) tap.onClosed(failure.reason)
      // 经中转的那条断了(中转、那台机器、网络):让远程隧道重新连一遍(❌ 留着一个看起来通着的映射)。
      if (viaTunnel) options.tunnels?.reportBroken(deviceId)
    },
    log: options.log,
  })
  // 主动收掉不报 onClosed(ssh-link.ts):窗口那头关、机器被移除时,挂着的那几位(主进程)由这里告诉,否则它们一直以为线还在。
  const rawClose = links.close
  const close = (deviceId: string) => {
    rawClose(deviceId)
    for (const tap of [...(taps.get(deviceId) ?? [])]) tap.onClosed('closed')
  }
  const tap: SharedSshLinks['tap'] = (deviceId, handlers) => {
    const set = taps.get(deviceId) ?? new Set()
    set.add(handlers)
    taps.set(deviceId, set)
    return () => {
      set.delete(handlers)
      if (set.size === 0 && taps.get(deviceId) === set) taps.delete(deviceId)
    }
  }
  const channel = options.upgradeChannel
  // 报给那台机器的「这台桌面是哪一版」:正式版 = 自己的版本;开发 / 测试可用 GUGU_SERVER_MATCH_VERSION 覆盖(见 reportedDesktopVersion)。
  // process.defaultApp:Electron 以「electron .」起的(没打包)时为 true。
  const desktopVersion = reportedDesktopVersion(process.env, { packaged: process.defaultApp !== true })
  // 渲染层开窗口时报的也是这一个(src/lib/remoteSessionHost.ts),两处 ❌ 各算各的。
  options.ipcMain.handle(SSH_LINK_CHANNELS.desktopVersion, () => desktopVersion)
  const upgrader: SshAutoUpgrader | null =
    options.upgrader ??
    (channel
      ? createSshAutoUpgrader({
          run: sshServerUpgradeRunner({
            targetFor: async (deviceId) => {
              const machine = await machineFor(deviceId)
              return machine ? sshTargetOf(machine) : null
            },
            matchFor: async (deviceId) => {
              const machine = await machineFor(deviceId)
              const id = (await options.desktopId?.().catch(() => null)) ?? null
              if (!machine || !id || !desktopVersion) return null
              return { accountUserId: machine.ownerUserId, desktop: { id: desktopReportId(id, desktopVersion), version: desktopVersion, protocol: REMOTE_PROTOCOL_VERSION } }
            },
            controlPath: terminalControlPath,
            channel,
            spawnSsh: systemSpawnSsh(process.env),
          }),
          emit: (event: SshUpgradeEvent) => send(SSH_LINK_CHANNELS.upgradeState, event),
          desktopVersion,
          log: options.log,
        })
      : null)

  options.ipcMain.handle(SSH_LINK_CHANNELS.open, async (_event, deviceId: unknown): Promise<SshLinkOpenResult> => {
    if (typeof deviceId !== 'string' || !ID.test(deviceId)) return { ok: false, reason: 'unmapped' }
    // 正在替它升级:这时开出去只会撞上还没换下来的旧版本,❌ 再起一个 ssh。
    if (upgrader?.upgrading(deviceId)) return { ok: false, reason: 'updating' }
    // 原因的原文只进日志(ssh-link.ts 已记),渲染层只拿原因码。
    const result = await links.open(deviceId)
    // 经远程隧道的机器:不替它升级(它自己经咕咕云换版本);连不上 = 中转那条路坏了,让远程隧道重连。
    if (!(await machineFor(deviceId)) && options.tunnels?.linkMachine(deviceId)) {
      if (!result.ok && result.reason !== 'outdated') options.tunnels.reportBroken(deviceId)
      return result.ok ? result : { ok: false, reason: result.reason, via: 'tunnel' }
    }
    return openOutcome(deviceId, result, upgrader)
  })
  options.ipcMain.handle(SSH_LINK_CHANNELS.upgrade, async (_event, request: { deviceId?: unknown; force?: unknown; desktopTooOld?: unknown }) => {
    if (!request || typeof request.deviceId !== 'string' || !ID.test(request.deviceId) || !upgrader) return false
    if (!(await machineFor(request.deviceId))) return false
    return upgrader.request(request.deviceId, { force: request.force === true, desktopTooOld: request.desktopTooOld === true })
  })
  options.ipcMain.handle(SSH_LINK_CHANNELS.send, (_event, request: { deviceId?: unknown; message?: unknown }) => {
    if (!request || typeof request.deviceId !== 'string') return false
    return links.send(request.deviceId, request.message)
  })
  options.ipcMain.handle(SSH_LINK_CHANNELS.close, (_event, deviceId: unknown) => {
    if (typeof deviceId === 'string') close(deviceId)
  })

  // ── 登录(人点的那一下)──────────────────────────────────────────────────────
  const signIns = new Map<string, { askpass: DirectTerminalAskpass | null; done: Promise<SshLinkOpenResult> }>()
  options.ipcMain.handle(SSH_LINK_CHANNELS.signIn, async (_event, deviceId: unknown): Promise<SshLinkOpenResult> => {
    if (typeof deviceId !== 'string' || !ID.test(deviceId)) return { ok: false, reason: 'unmapped' }
    const running = signIns.get(deviceId)
    if (running) return running.done
    const entry: { askpass: DirectTerminalAskpass | null; done: Promise<SshLinkOpenResult> } = {
      askpass: null,
      done: Promise.resolve({ ok: false, reason: 'unmapped' }),
    }
    entry.done = (async (): Promise<SshLinkOpenResult> => {
      const machine = await machineFor(deviceId)
      const controlPath = terminalControlPath()
      if (!machine) return { ok: false, reason: 'unmapped' }
      // Windows 自带的 OpenSSH 没有共享连接:登录这一下留不住,设备连接只能靠钥匙(照旧如实说要登录)。
      if (!controlPath) return openOutcome(deviceId, await links.open(deviceId), upgrader)
      const install = options.installKey
      const askpass = await createTerminalAskpass(
        undefined,
        install ? (password) => install(machine, controlPath, password) : undefined,
      )
      entry.askpass = askpass
      askpass.onPrompt((prompt) => send(SSH_LINK_CHANNELS.prompt, { deviceId, prompt }))
      askpass.onKeyInstall?.((outcome) => send(KEY_INSTALL_EVENT, { label: machine.display, outcome }))
      try {
        const exit = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
          const child = spawn('ssh', buildEnsureMasterArgs(sshTargetOf(machine), controlPath), {
            stdio: ['ignore', 'ignore', 'pipe'],
            env: { ...process.env, ...askpass.env },
            windowsHide: true,
          })
          let stderr = ''
          child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
            if (stderr.length < 16_384) stderr += chunk
          })
          child.on('error', (error) => resolve({ code: null, stderr: error.message }))
          child.on('close', (code) => resolve({ code, stderr }))
        })
        const outcome = classifySignInExit(exit.code, exit.stderr)
        if (!outcome.ok) {
          options.log?.('ssh link: sign-in failed', { deviceId, code: exit.code, detail: exit.stderr.trim().split(/\r?\n/).slice(-3).join('\n') })
          return outcome
        }
        askpass.authenticated?.()
      } finally {
        send(SSH_LINK_CHANNELS.prompt, { deviceId, prompt: null })
        // 钥匙可能还在装(装完才报结果):askpass 的目录与套接字此刻就能收掉,装钥匙用的是刚才那条共享连接。
        void askpass.close()
      }
      return openOutcome(deviceId, await links.open(deviceId), upgrader)
    })()
    signIns.set(deviceId, entry)
    try {
      return await entry.done
    } finally {
      signIns.delete(deviceId)
    }
  })
  options.ipcMain.handle(SSH_LINK_CHANNELS.answer, (_event, answer: SshLinkAnswer) => {
    if (!answer || typeof answer.deviceId !== 'string' || typeof answer.promptId !== 'string') return false
    const askpass = signIns.get(answer.deviceId)?.askpass
    if (!askpass) return false
    return askpass.answer(answer.promptId, answer.value, answer.installKey ? { installKey: true } : undefined)
  })

  // 机器被移除 / 忘掉:它的设备连接当场收掉(❌ 留一条通到已经不归这台桌面管的机器的连接)。
  options.store.onChange(() => {
    const known = new Set(options.store.list().map((m) => m.deviceId))
    for (const deviceId of links.openDeviceIds()) if (!known.has(deviceId)) close(deviceId)
  })
  // closeAll 经 this.close 收,也走上面那一层。
  return Object.assign(links, { close, tap })
}
