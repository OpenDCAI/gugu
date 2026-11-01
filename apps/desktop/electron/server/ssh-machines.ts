/**
 * #6264「别的机器上的编程只给用 SSH 装上的机器」(product spec「会话页里的别的机器」)。
 *
 * 「用 SSH 装上的机器」在这台桌面上的记录:SSH 一步装好成功、并且那台机器报了自己的设备 id 时记一笔
 * 「设备 id → 怎么 SSH 过去」。只记目的地(别名 / 用户@主机 / 端口),❌ 不记任何密码、口令、密钥 ——
 * 真连的时候照旧用本机的 ssh 与 ~/.ssh/config(与安装同一条原则)。只存在本机,不上云:
 * 换一台电脑就没有这条直连通道,那台电脑上看这台机器只有「通用」,与 spec 一致。
 *
 * 它有两个读者:
 *  · 渲染层(会话页经 gugu 侧的桥)问「哪些设备能直连」,决定新建时给不给「编程」、打开时用不用终端;
 *  · 会话页引擎开端口转发时问「这台怎么连」(DirectTerminalResolver)。
 */
import { spawn, spawnSync } from '@gugu/core/local/childProcess'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { BrowserWindow } from 'electron'
import {
  SERVER_SSH_MACHINES_CHANNELS,
  type SshMachineSummary,
  type SshSignInState,
} from '../../src/lib/serverSshMachines'
import type { DirectTerminalResolver } from '../session/main/core/pty/direct-terminal/controller'
import type { DirectTerminalAskpass } from '../session/main/core/pty/direct-terminal/ssh-connect'
import {
  buildEnsureMasterArgs,
  buildForwardSshArgs,
  buildMuxControlArgs,
  buildMuxForwardArgs,
  classifyAttachExit,
  hostForKnownHosts,
  isSafeSshOptionList,
  type SshTarget,
} from './ssh-install/logic'
import { createTerminalAskpass } from './ssh-prompts'
import { installGuguKeyWithPassword, withGuguIdentity, type SshKeyInstallOutcome } from './ssh-key-install'
import { sshSignInState } from './ssh-sign-in-state'

export type SshMachine = {
  deviceId: string
  /** 登在那台机器上的咕咕账号(= 装的时候桌面登着的人)。换号之后这条不算数。 */
  ownerUserId: string
  destination: string
  port?: number
  /** 装的时候从整条 ssh 命令里带过来的连接选项(密钥、跳板;已按白名单校验),开终端时照样带上。 */
  options?: string[]
  /** 给人看的一串(`用户@主机:端口`)。 */
  display: string
  addedAt: string
}

const ID = /^[A-Za-z0-9_-]{1,128}$/

function isMachine(value: unknown): value is SshMachine {
  const m = value as Partial<SshMachine> | null
  return (
    !!m &&
    typeof m.deviceId === 'string' && ID.test(m.deviceId) &&
    typeof m.ownerUserId === 'string' && ID.test(m.ownerUserId) &&
    typeof m.destination === 'string' && m.destination.length > 0 && !m.destination.startsWith('-') &&
    typeof m.display === 'string' &&
    typeof m.addedAt === 'string' &&
    (m.port === undefined || (Number.isInteger(m.port) && m.port > 0 && m.port < 65536)) &&
    (m.options === undefined || (Array.isArray(m.options) && isSafeSshOptionList(m.options)))
  )
}

/** 读盘:文件坏了/字段不对的条目丢掉(那是一台连不上的机器,不是一个要报的错)。 */
export function parseSshMachines(text: string): SshMachine[] {
  try {
    const data = JSON.parse(text) as { machines?: unknown }
    return Array.isArray(data.machines) ? data.machines.filter(isMachine) : []
  } catch {
    return []
  }
}

/** 同一台设备再装一次(换了地址、换了端口)就覆盖旧的那条。 */
export function upsertSshMachine(machines: readonly SshMachine[], next: SshMachine): SshMachine[] {
  return [...machines.filter((m) => m.deviceId !== next.deviceId), next]
}

export function findSshMachine(machines: readonly SshMachine[], deviceId: string, ownerUserId: string): SshMachine | null {
  return machines.find((m) => m.deviceId === deviceId && m.ownerUserId === ownerUserId) ?? null
}

/** 刚装上、设备行还没出现的宽限(装好到第一次心跳落库通常几秒;多给些余量)。 */
export const RECONCILE_GRACE_MS = 10 * 60_000

/**
 * #6264 账号名下已经没有的机器(在别的电脑上被移除了)—— 这台电脑也该忘掉它,❌ 留一条通不到任何东西的映射。
 * 只看这个账号装上的;刚装上还在宽限里的不算(它的设备行可能还没落库)。纯函数。
 */
export function machinesGoneFromAccount(
  machines: readonly SshMachine[],
  ownerUserId: string,
  present: ReadonlySet<string>,
  nowMs: number,
  graceMs: number = RECONCILE_GRACE_MS,
): SshMachine[] {
  return machines.filter((m) => {
    if (m.ownerUserId !== ownerUserId || present.has(m.deviceId)) return false
    const added = Date.parse(m.addedAt)
    return Number.isNaN(added) || nowMs - added >= graceMs
  })
}

export type SshMachineStore = {
  list(): SshMachine[]
  remember(machine: SshMachine): void
  /** 忘掉一台(移除 / 卸载之后)。本来就没有 ⇒ false。 */
  forget(deviceId: string): boolean
  onChange(listener: () => void): () => void
}

/** 渲染层看得到的那一份:设备 id + 给人看的地址。❌ 不给目的地原串与端口(它们只在真连的时候用)。 */
export function summarizeSshMachines(machines: readonly SshMachine[]): SshMachineSummary[] {
  return machines.map((m) => ({ deviceId: m.deviceId, display: m.display }))
}

export function createSshMachineStore(file: string): SshMachineStore {
  const listeners = new Set<() => void>()
  let cache: SshMachine[] | null = null
  const list = (): SshMachine[] => {
    if (cache) return cache
    try {
      cache = parseSshMachines(fs.readFileSync(file, 'utf8'))
    } catch {
      cache = []
    }
    return cache
  }
  const save = (next: SshMachine[]): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, machines: next }, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(tmp, file)
    cache = next
    for (const listener of listeners) listener()
  }
  return {
    list,
    remember(machine) {
      save(upsertSshMachine(list(), machine))
    },
    forget(deviceId) {
      const current = list()
      const next = current.filter((m) => m.deviceId !== deviceId)
      if (next.length === current.length) return false
      save(next)
      return true
    },
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

let controlScope = ''

/**
 * #6264 共享连接的套接字目录按「哪一个咕咕」分开(数据目录的短哈希):同一台电脑上并行开着的几个咕咕
 * (开发实例、两个账号目录)各管各的连接 —— 一个退出时收掉自己的,❌ 把另一个正在用的也掐了。
 * 启动时调一次;没调就用不分的老目录。
 */
export function configureSshControlScope(userData: string): void {
  controlScope = userData ? crypto.createHash('sha256').update(userData).digest('hex').slice(0, 8) : ''
}

/** 共享连接的套接字目录(不建)。 */
export function sshControlDir(): string | null {
  if (process.platform === 'win32') return null
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0
  return path.join('/tmp', controlScope ? `gugu-ssh-${uid}-${controlScope}` : `gugu-ssh-term-${uid}`)
}

/**
 * 直连终端复用 SSH 连接的套接字目录。要短(unix 套接字路径上限约 104 字节,%C 就占 40)、
 * 只有本用户进得去;/tmp 下被别人抢先建了同名目录就不复用(每次各连各的,照样能用)。
 * Windows 自带的 OpenSSH 不支持 ControlMaster。
 */
export function terminalControlPath(): string | null {
  const dir = sshControlDir()
  if (!dir) return null
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const stat = fs.lstatSync(dir)
    if (!stat.isDirectory() || (typeof process.getuid === 'function' && stat.uid !== uid)) return null
    fs.chmodSync(dir, 0o700)
  } catch {
    return null
  }
  return path.join(dir, 'cm-%C')
}

/** 会话页引擎开端口转发时问的那一句:这台设备能直连就给出 ssh 命令。 */
export function createDirectTerminalResolver(options: {
  store: Pick<SshMachineStore, 'list'>
  /** 桌面此刻登着的账号;没登录 = 不直连。 */
  currentUserId: () => Promise<string | null>
  controlPath?: () => string | null
  /**
   * ssh 问人(密码、口令、验证码、新主机指纹)的通道:与添加机器同一套 askpass + 提问卡片。
   * 开不出来(本机建不了临时目录这类)就不带 —— ssh 退回在终端里自己问,终端照样能用。
   */
  askpass?: (installKey?: (password: string) => Promise<SshKeyInstallOutcome>) => Promise<DirectTerminalAskpass>
  onAskpassError?: (error: unknown) => void
  /**
   * #6264「下次免密」:人用密码登上这台机器、并勾了「以后不用再输密码」时,替他把咕咕的钥匙装上去
   * (见 createMachineKeyInstaller)。不给 = 密码提问上不出那个勾。
   */
  installKey?: (machine: SshMachine, controlPath: string | null, password: string) => Promise<SshKeyInstallOutcome>
  /** 远程隧道:经中转连通了的机器(tunnel-machines.ts)。端口转发骑在它那条共享连接上,与远程 SSH 的机器一样。 */
  tunnels?: { linkMachine(deviceId: string): { target: SshTarget } | null }
}): DirectTerminalResolver {
  return async ({ deviceId, purpose }) => {
    // 只剩端口转发经这里直连(#6264 一套工作台:终端与会话走那台机器的设备连接,不另开一条 SSH)。
    if (purpose?.kind !== 'forward') return null
    const userId = await options.currentUserId()
    if (!userId) return null
    const machine = findSshMachine(options.store.list(), deviceId, userId)
    if (!machine) return tunnelForward(options, deviceId, purpose)
    const target = sshTargetOf(machine)
    const controlPath = (options.controlPath ?? terminalControlPath)()
    // 转发骑在共享连接上(ssh -O forward),❌ 另开一条再认证;没有复用连接(Windows)才单开一条。
    const mux = controlPath
      ? {
          ensureArgs: buildEnsureMasterArgs(target, controlPath),
          forwardArgs: buildMuxForwardArgs(target, { controlPath, localPort: purpose.localPort, remotePort: purpose.remotePort, op: 'forward' }),
          cancelArgs: buildMuxForwardArgs(target, { controlPath, localPort: purpose.localPort, remotePort: purpose.remotePort, op: 'cancel' }),
        }
      : null
    const args = buildForwardSshArgs(target, { localPort: purpose.localPort, remotePort: purpose.remotePort })
    let askpass: DirectTerminalAskpass | undefined
    try {
      const install = options.installKey
      const installKey = install ? (password: string) => install(machine, controlPath, password) : undefined
      askpass = await (options.askpass ?? ((install) => createTerminalAskpass(undefined, install)))(installKey)
    } catch (error) {
      options.onAskpassError?.(error)
    }
    const knownHost = hostForKnownHosts(target)
    return {
      command: 'ssh',
      args,
      label: machine.display,
      classifyExit: (info) => classifyAttachExit(info, knownHost),
      ...(askpass ? { askpass } : {}),
      ...(mux ? { mux } : {}),
    }
  }
}

/** 经远程隧道的那台:只用咕咕钥匙(BatchMode,❌ 问密码),共享连接已由 tunnel-machines.ts 建好。 */
function tunnelForward(
  options: { tunnels?: { linkMachine(deviceId: string): { target: SshTarget } | null }; controlPath?: () => string | null },
  deviceId: string,
  purpose: { localPort: number; remotePort: number },
): ReturnType<DirectTerminalResolver> {
  const tunnel = options.tunnels?.linkMachine(deviceId)
  if (!tunnel) return Promise.resolve(null)
  const target = { ...tunnel.target, options: ['-o', 'BatchMode=yes', ...(tunnel.target.options ?? [])] }
  const controlPath = (options.controlPath ?? terminalControlPath)()
  const mux = controlPath
    ? {
        ensureArgs: buildEnsureMasterArgs(target, controlPath),
        forwardArgs: buildMuxForwardArgs(target, { controlPath, localPort: purpose.localPort, remotePort: purpose.remotePort, op: 'forward' }),
        cancelArgs: buildMuxForwardArgs(target, { controlPath, localPort: purpose.localPort, remotePort: purpose.remotePort, op: 'cancel' }),
      }
    : null
  return Promise.resolve({
    command: 'ssh',
    args: buildForwardSshArgs(target, { localPort: purpose.localPort, remotePort: purpose.remotePort }),
    label: target.display,
    classifyExit: (info) => classifyAttachExit(info, hostForKnownHosts(target)),
    ...(mux ? { mux } : {}),
  })
}

/**
 * 收掉一台机器那条共享连接(机器被移除 / 卸载之后):❌ 留一条认证过的连接挂在后台。
 * 选项照连的时候一样带上(%C 按主机、端口、用户、跳板算)。
 */
export function closeMachineMaster(machine: SshMachine, controlPath: string | null = terminalControlPath()): Promise<void> {
  if (!controlPath) return Promise.resolve()
  return new Promise((resolve) => {
    const child = spawn('ssh', buildMuxControlArgs(sshTargetOf(machine), controlPath, 'exit'), { stdio: 'ignore' })
    child.on('error', () => resolve())
    child.on('exit', () => resolve())
  })
}

/**
 * 收掉这个咕咕开着的所有共享连接:退出时(一条一条 `ssh -O exit`,每条最多等 2 秒),
 * 以及启动时(上次没正常退出留下的)。只看自己那个目录(按数据目录分开的),❌ 碰别的咕咕的。
 * 成本:目录里有几条连接就起几个一闪而过的 ssh(量级 = 连过的机器数);只在启动 / 退出时各跑一次。
 */
export function closeSshMasters(dir: string | null = sshControlDir(), run: (args: string[]) => void = defaultRunSync): number {
  if (!dir) return 0
  let names: string[]
  try {
    names = fs.readdirSync(dir).filter((name) => name.startsWith('cm-'))
  } catch {
    return 0
  }
  for (const name of names) run(['-o', `ControlPath=${path.join(dir, name)}`, '-O', 'exit', 'gugu-shared-connection'])
  return names.length
}

function defaultRunSync(args: string[]): void {
  spawnSync('ssh', args, { stdio: 'ignore', timeout: 2_000 })
}

/** 启动时那一次:不挡主进程(退出时才用同步的那一份,进程马上要走了)。 */
export function runSshInBackground(args: string[]): void {
  const child = spawn('ssh', args, { stdio: 'ignore' })
  child.on('error', () => undefined)
}

/**
 * #6264「下次免密」真做的那一份:装钥匙 + 验一次;过了就把咕咕的钥匙关联到这台机器(以后每次连都带上它,
 * 照 Termius「Export to host」之后钥匙关联到主机)。❌ 动别的字段、❌ 碰用户自己的 ~/.ssh。
 */
export function createMachineKeyInstaller(options: {
  store: Pick<SshMachineStore, 'list' | 'remember'>
  keyDir: string
  install?: typeof installGuguKeyWithPassword
  log?: (message: string, detail?: Record<string, unknown>) => void
}): (machine: SshMachine, controlPath: string | null, password: string) => Promise<SshKeyInstallOutcome> {
  return async (machine, controlPath, password) => {
    const result = await (options.install ?? installGuguKeyWithPassword)({
      target: sshTargetOf(machine),
      controlPath,
      password,
      keyDir: options.keyDir,
      log: options.log,
    })
    if (result.status === 'failed') return { status: 'failed', reason: result.reason }
    if (!result.keyPath) return { status: 'installed' }
    // 装的这会儿记录可能被改过(重新登录换了地址):以此刻存着的那条为准,只加钥匙这一项。
    const latest = options.store.list().find((m) => m.deviceId === machine.deviceId && m.ownerUserId === machine.ownerUserId) ?? machine
    options.store.remember({ ...latest, options: withGuguIdentity(latest.options, result.keyPath) })
    return { status: 'installed' }
  }
}

/** 一台记下的机器 → ssh 目标(带上添加时给的额外选项,如 -i / -J)。直连终端、附件直传、卸载共用这一份。 */
export function sshTargetOf(machine: SshMachine): SshTarget {
  return {
    destination: machine.destination,
    port: machine.port,
    display: machine.display,
    ...(machine.options?.length ? { options: machine.options } : {}),
  }
}

/**
 * 渲染层要设备 id 清单(会话页)与给人看的地址(设置 → 设备);❌ 不给它目的地原串与端口。
 * 附件直传也在这里:目的地只在主进程里。
 */
export function registerSshMachinesIpc(options: {
  ipcMain: Electron.IpcMain
  getWindow: () => BrowserWindow | null
  store: SshMachineStore
  /** 桌面此刻登着的账号;映射只认同一个账号装上的机器。 */
  currentUserId?: () => Promise<string | null>
}): void {
  // 只给桌面此刻登着的账号装上的那些(换了账号,上一个人的机器 ❌ 出现在这个人的列表里、❌ 被挑成 SSH 通道)。
  const mine = async (): Promise<SshMachine[]> => {
    const userId = (await options.currentUserId?.().catch(() => null)) ?? null
    return userId ? options.store.list().filter((m) => m.ownerUserId === userId) : []
  }
  const ids = async () => (await mine()).map((m) => m.deviceId)
  options.ipcMain.handle(SERVER_SSH_MACHINES_CHANNELS.list, () => ids())
  options.ipcMain.handle(SERVER_SSH_MACHINES_CHANNELS.describe, async () => summarizeSshMachines(await mine()))
  options.ipcMain.handle(SERVER_SSH_MACHINES_CHANNELS.forget, async (_event, deviceId: unknown) => {
    if (typeof deviceId !== 'string' || !ID.test(deviceId)) return false
    // 只忘此刻登着的这个人装上的那台:别人(换号前的那个人)装的 ❌ 被这个人删掉;没登录 ⇒ 谁的都不删。
    const machine = (await mine()).find((m) => m.deviceId === deviceId)
    if (!machine) return false
    // 机器移除了:它那条共享连接一并收掉(❌ 留一条认证过的连接挂在后台)。
    void closeMachineMaster(machine)
    return options.store.forget(deviceId)
  })

  options.ipcMain.handle(SERVER_SSH_MACHINES_CHANNELS.reconcile, async (_event, input: unknown) => {
    const { owner, present } = (input ?? {}) as { owner?: unknown; present?: unknown }
    if (!Array.isArray(present) || !present.every((id) => typeof id === 'string')) return 0
    const userId = (await options.currentUserId?.().catch(() => null)) ?? null
    // 名单必须是此刻登着的这个人的(换号那一瞬,上一个人的名单 ❌ 拿来删这个人的机器)。
    if (!userId || owner !== userId) return 0
    const gone = machinesGoneFromAccount(options.store.list(), userId, new Set(present as string[]), Date.now())
    for (const machine of gone) {
      void closeMachineMaster(machine)
      options.store.forget(machine.deviceId)
    }
    return gone.length
  })

  const machineFor = async (deviceId: string): Promise<SshMachine | null> => {
    const userId = (await options.currentUserId?.().catch(() => null)) ?? null
    return userId ? findSshMachine(options.store.list(), deviceId, userId) : null
  }
  // 设置页与会话页侧栏可能同时来问同一台:在途的并成一次,答案留一分钟(❌ 每个面各连一次 SSH)。
  const signInAsked = new Map<string, { at: number; answer: Promise<SshSignInState> }>()
  options.ipcMain.handle(SERVER_SSH_MACHINES_CHANNELS.signInState, async (_event, deviceId: unknown): Promise<SshSignInState> => {
    if (typeof deviceId !== 'string' || !ID.test(deviceId)) return { state: 'unknown' }
    const cached = signInAsked.get(deviceId)
    if (cached && Date.now() - cached.at < 60_000) return cached.answer
    const answer = (async (): Promise<SshSignInState> => {
      const machine = await machineFor(deviceId)
      if (!machine) return { state: 'unknown' }
      return sshSignInState({ target: sshTargetOf(machine), controlPath: terminalControlPath(), userId: machine.ownerUserId })
    })()
    signInAsked.set(deviceId, { at: Date.now(), answer })
    return answer
  })
  options.store.onChange(() => {
    void ids().then((list) => {
      const win = options.getWindow()
      if (win && !win.isDestroyed()) win.webContents.send(SERVER_SSH_MACHINES_CHANNELS.changed, list)
    })
  })
}

export function defaultSshMachinesFile(userData: string): string {
  return path.join(userData || os.homedir(), 'ssh-machines.json')
}
