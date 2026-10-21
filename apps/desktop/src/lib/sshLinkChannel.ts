// #6264 渲染层这一侧的「设备连接」(远程 SSH 的机器,契约见 ./sshLink.ts)。
//
// 两件事:
//  · 这台桌面上有哪些远程 SSH 的机器(主进程记的本机映射,只算桌面此刻登着的账号装上的)—— 设备 RPC 客户端
//    据此给每台机器挑通道(在清单里 = 走 SSH,不在 = 走咕咕云);
//  · 一台机器的设备连接,形状与 Realtime 频道对齐(ready / send / 收到一条 / 断了),deviceRpc.ts 直接换用。
// 手机与网页里没有主进程 ⇒ 清单恒为空、没有设备连接:远程 SSH 的机器在那里经咕咕云用(owner 2026-10-08 选 B)。

import { SERVER_SSH_MACHINES_CHANNELS } from './serverSshMachines'
import { TUNNEL_MACHINES_CHANNELS, type TunnelState, type TunnelWant } from './tunnelMachines'
import {
  SSH_LINK_CHANNELS,
  SshLinkError,
  type SshLinkClosedEvent,
  type SshLinkFailure,
  type SshLinkMessageEvent,
  type SshLinkOpenResult,
  type SshLinkAnswer,
  type SshLinkPromptEvent,
  type SshUpgradeEvent,
} from './sshLink'

type ElectronBridge = {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  eventOn(channel: string, cb: (data: unknown) => void): () => void
}

function bridge(): ElectronBridge | null {
  if (typeof window === 'undefined') return null
  return (window as unknown as { electronAPI?: ElectronBridge }).electronAPI ?? null
}

// ── 这台桌面上的远程 SSH 机器 ──────────────────────────────────────────────────

let machineIds: ReadonlySet<string> = new Set()
const machineListeners = new Set<(ids: ReadonlySet<string>) => void>()
let registryReady: Promise<void> | null = null

function applyIds(value: unknown): void {
  if (!Array.isArray(value)) return
  const next = new Set(value.filter((v): v is string => typeof v === 'string'))
  if (next.size === machineIds.size && [...next].every((id) => machineIds.has(id))) return
  machineIds = next
  for (const listener of [...machineListeners]) listener(machineIds)
}

/**
 * 清单读好了没有。第一次调用时去主进程取、并订阅之后的变化(装上一台 / 移除一台 / 换了账号)。
 * 取不到(没有主进程、IPC 出错)按空清单算 —— ❌ 挂住调用方。
 */
export function sshMachinesReady(): Promise<void> {
  if (registryReady) return registryReady
  const electron = bridge()
  if (!electron) return (registryReady = Promise.resolve())
  electron.eventOn(SERVER_SSH_MACHINES_CHANNELS.changed, applyIds)
  registryReady = electron.invoke(SERVER_SSH_MACHINES_CHANNELS.list).then(applyIds, () => undefined)
  return registryReady
}

/** 换了账号:清单按新账号重取(主进程只给此刻登着的人装上的那些)。 */
export function refreshSshMachines(): Promise<void> {
  const electron = bridge()
  if (!electron) return Promise.resolve()
  if (!registryReady) return sshMachinesReady()
  registryReady = electron.invoke(SERVER_SSH_MACHINES_CHANNELS.list).then(applyIds, () => undefined)
  return registryReady
}

export function isSshMachine(deviceId: string): boolean {
  return machineIds.has(deviceId)
}

export function currentSshMachineIds(): ReadonlySet<string> {
  return machineIds
}

export function subscribeSshMachineIds(listener: (ids: ReadonlySet<string>) => void): () => void {
  void sshMachinesReady()
  machineListeners.add(listener)
  return () => {
    machineListeners.delete(listener)
  }
}

/** 测试用:换一份清单(并通知订阅者)。 */
export function _setSshMachineIdsForTesting(ids: readonly string[]): void {
  registryReady = Promise.resolve()
  applyIds([...ids])
}

// ── 远程隧道:经中转连通了的机器(主进程 electron/server/tunnel-machines.ts) ─────────────────
//
// 「只经咕咕云连着」的机器(远程隧道、云电脑、别的电脑用远程 SSH 添加的)中转通着时,主进程经中转连过去;
// 连通了就与远程 SSH 的机器同一套 —— 设备连接、终端、浏览器、端口。连不上的原因单独记(❌ 混进远程 SSH 的「要先登录」)。

let tunnelState: TunnelState = { ready: [], problems: {} }
let tunnelReady: ReadonlySet<string> = new Set()
const tunnelListeners = new Set<(state: TunnelState) => void>()
let tunnelWired = false

function applyTunnelState(value: unknown): void {
  const state = value as TunnelState | null
  if (!state || !Array.isArray(state.ready) || typeof state.problems !== 'object' || !state.problems) return
  const next = new Set(state.ready.filter((id): id is string => typeof id === 'string'))
  const same =
    next.size === tunnelReady.size &&
    [...next].every((id) => tunnelReady.has(id)) &&
    JSON.stringify(state.problems) === JSON.stringify(tunnelState.problems)
  if (same) return
  tunnelState = { ready: [...next], problems: { ...state.problems } }
  tunnelReady = next
  for (const listener of [...tunnelListeners]) listener(tunnelState)
}

function wireTunnel(electron: ElectronBridge): void {
  if (tunnelWired) return
  tunnelWired = true
  electron.eventOn(TUNNEL_MACHINES_CHANNELS.changed, applyTunnelState)
  void electron.invoke(TUNNEL_MACHINES_CHANNELS.state).then(applyTunnelState, () => undefined)
}

/** 这一端能不能自己经远程隧道连过去(有主进程 = 电脑上的咕咕;手机 / 网页没有)。 */
export function canOpenTunnels(): boolean {
  return bridge() !== null
}

/** 这台机器此刻经远程隧道连通着(设备连接走它)。 */
export function isTunnelLinked(deviceId: string): boolean {
  return tunnelReady.has(deviceId)
}

/** 设备连接(SSH 或远程隧道)走不走得通:设备 RPC 据此挑管道。 */
export function usesDeviceLink(deviceId: string): boolean {
  return isSshMachine(deviceId) || isTunnelLinked(deviceId)
}

export function currentTunnelState(): TunnelState {
  return tunnelState
}

export function subscribeTunnelState(listener: (state: TunnelState) => void): () => void {
  const electron = bridge()
  if (electron) wireTunnel(electron)
  tunnelListeners.add(listener)
  return () => {
    tunnelListeners.delete(listener)
  }
}

let lastWant = ''
/** 此刻要经远程隧道连的那些机器(在线、中转通着、这台电脑没有它的 SSH 映射)。没有主进程(手机 / 网页)= 不连。 */
export function wantTunnels(wants: readonly TunnelWant[]): void {
  const electron = bridge()
  if (!electron) return
  wireTunnel(electron)
  const key = JSON.stringify([...wants].sort((a, b) => a.deviceId.localeCompare(b.deviceId)))
  if (key === lastWant) return
  lastWant = key
  void electron.invoke(TUNNEL_MACHINES_CHANNELS.want, wants).then(applyTunnelState, () => undefined)
}

/** 测试用。 */
export function _setTunnelStateForTesting(state: TunnelState): void {
  applyTunnelState(state)
}

// ── 一台机器的设备连接 ─────────────────────────────────────────────────────────

/**
 * 每台远程 SSH 机器的设备连接此刻怎样(接上了 = null;接不上 / 断了 = 原因)。全局那张「要先登录」的
 * 浮卡(components/SshLinkSignIn.tsx)读它 —— 各个模块各自报错,「怎么修」只在一处给。
 */
const linkProblems = new Map<string, SshLinkFailure>()
const problemListeners = new Set<(problems: ReadonlyMap<string, SshLinkFailure>) => void>()

function setLinkProblem(deviceId: string, problem: SshLinkFailure | null): void {
  const before = linkProblems.get(deviceId) ?? null
  if (before === problem) return
  if (problem) linkProblems.set(deviceId, problem)
  else linkProblems.delete(deviceId)
  const snapshot = new Map(linkProblems)
  for (const listener of [...problemListeners]) listener(snapshot)
}

export function subscribeSshLinkProblems(listener: (problems: ReadonlyMap<string, SshLinkFailure>) => void): () => void {
  problemListeners.add(listener)
  listener(new Map(linkProblems))
  return () => {
    problemListeners.delete(listener)
  }
}

export type SshLinkHandle = {
  /** 接上了才 resolve;接不上 reject SshLinkError(带原因)。 */
  ready: Promise<void>
  send(message: unknown): Promise<void>
  close(): void
}

type LinkHandlers = { onMessage(message: unknown): void; onClosed(reason: SshLinkFailure): void }

const handlersByDevice = new Map<string, LinkHandlers>()
let eventsWired = false

function wireEvents(electron: ElectronBridge): void {
  if (eventsWired) return
  eventsWired = true
  electron.eventOn(SSH_LINK_CHANNELS.message, (data) => {
    const event = data as SshLinkMessageEvent | null
    if (event && typeof event.deviceId === 'string') handlersByDevice.get(event.deviceId)?.onMessage(event.message)
  })
  electron.eventOn(SSH_LINK_CHANNELS.upgradeState, (data) => applyUpgradeEvent(data as SshUpgradeEvent | null))
  electron.eventOn(SSH_LINK_CHANNELS.closed, (data) => {
    const event = data as SshLinkClosedEvent | null
    if (!event || typeof event.deviceId !== 'string') return
    // 远程隧道上的那条:原因由远程隧道自己报(subscribeTunnelState),❌ 冒成远程 SSH 的「要先登录」卡片。
    if (event.via !== 'tunnel') setLinkProblem(event.deviceId, event.reason)
    handlersByDevice.get(event.deviceId)?.onClosed(event.reason)
  })
}

export function openSshLink(deviceId: string, handlers: LinkHandlers): SshLinkHandle {
  const electron = bridge()
  if (!electron) {
    return {
      ready: Promise.reject(new SshLinkError('unmapped', deviceId)),
      send: () => Promise.reject(new SshLinkError('unmapped', deviceId)),
      close: () => undefined,
    }
  }
  wireEvents(electron)
  handlersByDevice.set(deviceId, handlers)
  let closed = false
  const ready = (electron.invoke(SSH_LINK_CHANNELS.open, deviceId) as Promise<SshLinkOpenResult>).then(
    (result) => {
      if (!result || !result.ok) {
        const reason = result && !result.ok ? result.reason : 'unreachable'
        if (!(result && !result.ok && result.via === 'tunnel')) setLinkProblem(deviceId, reason)
        throw new SshLinkError(reason, deviceId)
      }
      setLinkProblem(deviceId, null)
    },
    () => {
      setLinkProblem(deviceId, 'unreachable')
      throw new SshLinkError('unreachable', deviceId)
    },
  )
  return {
    ready,
    async send(message) {
      const sent = (await electron.invoke(SSH_LINK_CHANNELS.send, { deviceId, message })) as boolean
      if (!sent) throw new SshLinkError('unreachable', deviceId)
    },
    close() {
      if (closed) return
      closed = true
      if (handlersByDevice.get(deviceId) === handlers) handlersByDevice.delete(deviceId)
      void electron.invoke(SSH_LINK_CHANNELS.close, deviceId).catch(() => undefined)
    },
  }
}

/**
 * 人点「登录」:经提问卡片问一次(密码 / 口令 / 新主机指纹),登上后主进程接着把设备连接开好。
 * 成了之后这台的「连不上」清掉,还在听推送的订阅者随之重新接上(deviceRpc.ts 的重开)。
 */
export async function signInSshMachine(deviceId: string): Promise<SshLinkOpenResult> {
  const electron = bridge()
  if (!electron) return { ok: false, reason: 'unmapped' }
  let result: SshLinkOpenResult
  try {
    result = (await electron.invoke(SSH_LINK_CHANNELS.signIn, deviceId)) as SshLinkOpenResult
  } catch {
    result = { ok: false, reason: 'unreachable' }
  }
  if (result.ok) {
    setLinkProblem(deviceId, null)
    for (const listener of [...signedInListeners]) listener(deviceId)
  } else {
    setLinkProblem(deviceId, result.reason)
  }
  return result
}

const signedInListeners = new Set<(deviceId: string) => void>()

// ── 太旧时替它升级(主进程在做,这里只记进度、升完叫重连)─────────────────────────────

/** 正在替它升级的那几台:deviceId → 进度百分比(不知道总量 = null)。 */
const upgrades = new Map<string, number | null>()
/** 老到没法自动更新的那几台:deviceId → 请人在那台机器上跑的安装命令(随「没升成」一起来)。 */
const reinstallCommands = new Map<string, string>()

export function sshReinstallCommand(deviceId: string): string | null {
  return reinstallCommands.get(deviceId) ?? null
}
const upgradeListeners = new Set<(upgrades: ReadonlyMap<string, number | null>) => void>()

function publishUpgrades(): void {
  const snapshot = new Map(upgrades)
  for (const listener of [...upgradeListeners]) listener(snapshot)
}

/** 主进程报来的一步:在升 → 「正在更新」;升好 → 清掉问题并当场重连(与刚登上同一条路);没升成 → 停在「版本太旧」。 */
export function applyUpgradeEvent(event: SshUpgradeEvent | null): void {
  if (!event || typeof event.deviceId !== 'string') return
  const { deviceId } = event
  if (event.phase === 'failed' && event.reinstall) reinstallCommands.set(deviceId, event.reinstall)
  else reinstallCommands.delete(deviceId)
  if (event.phase === 'updating') {
    upgrades.set(deviceId, typeof event.percent === 'number' ? event.percent : null)
    setLinkProblem(deviceId, 'updating')
  } else if (event.phase === 'desktopTooOld') {
    // 连接本身没毛病;「请更新这台电脑上的咕咕」由那台机器报的协议窗口说(serverMachineNotices)。
    upgrades.delete(deviceId)
    setLinkProblem(deviceId, null)
  } else {
    upgrades.delete(deviceId)
    setLinkProblem(deviceId, event.phase === 'done' ? null : 'outdated')
    if (event.phase === 'done') for (const listener of [...signedInListeners]) listener(deviceId)
  }
  publishUpgrades()
}

export function subscribeSshUpgrades(listener: (upgrades: ReadonlyMap<string, number | null>) => void): () => void {
  const electron = bridge()
  if (electron) wireEvents(electron)
  upgradeListeners.add(listener)
  listener(new Map(upgrades))
  return () => {
    upgradeListeners.delete(listener)
  }
}

/**
 * 请主进程替这台升级(会话页宿主说「太旧」时 / 人点「重试」时;设备连接开出太旧时主进程自己会发起)。
 * 返回此刻是不是在升。`force` = 人点的,不看失败后的冷却。
 */
export async function requestSshServerUpgrade(deviceId: string, options?: { force?: boolean; /** 由「这台电脑太旧」发起:只换成匹配的版本;没发起(冷却中)不改连接状况。 */ desktopTooOld?: boolean }): Promise<boolean> {
  const electron = bridge()
  if (!electron) return false
  wireEvents(electron)
  let started = false
  try {
    started = (await electron.invoke(SSH_LINK_CHANNELS.upgrade, { deviceId, force: options?.force === true, desktopTooOld: options?.desktopTooOld === true })) === true
  } catch {
    started = false
  }
  // 没在升(刚失败过、还在冷却):说「版本太旧、更新没成功」,❌ 让它落回「重连中」。
  // desktopTooOld:「这台电脑太旧」那一问 —— 没发起(冷却中)不改连接状况,连接本身没毛病。
  if (isSshMachine(deviceId) && (started || !options?.desktopTooOld)) setLinkProblem(deviceId, started ? 'updating' : 'outdated')
  return started
}

/** 人刚登上了这台(deviceRpc.ts 据此当场重开这台的频道,❌ 等退避计时)。 */
export function onSshMachineSignedIn(listener: (deviceId: string) => void): () => void {
  signedInListeners.add(listener)
  return () => {
    signedInListeners.delete(listener)
  }
}

export function answerSshSignInPrompt(answer: SshLinkAnswer): void {
  void bridge()?.invoke(SSH_LINK_CHANNELS.answer, answer).catch(() => undefined)
}

export function subscribeSshSignInPrompts(listener: (event: SshLinkPromptEvent) => void): () => void {
  const electron = bridge()
  if (!electron) return () => undefined
  return electron.eventOn(SSH_LINK_CHANNELS.prompt, (data) => {
    const event = data as SshLinkPromptEvent | null
    if (event && typeof event.deviceId === 'string') listener(event)
  })
}

/** #6264 这台桌面报给咕咕 server 的版本(主进程算,开发 / 测试可覆盖);没有主进程 / 问不到 = null(调用方退回自己的版本)。 */
export async function desktopMatchVersion(): Promise<string | null> {
  const electron = bridge()
  if (!electron) return null
  try {
    const value = await electron.invoke(SSH_LINK_CHANNELS.desktopVersion)
    return typeof value === 'string' && value ? value : null
  } catch {
    return null
  }
}

/**
 * 建 agent 之前的在线判定,在添加这台机器的电脑上:远程 SSH 的机器只看设备连接(与侧栏、顶上卡片同一个说法),
 * 已知要先登录 / 那台机器上没登 → 当场抛。返回 true = 它是这台电脑用远程 SSH 添加的(调用方跳过心跳判定)。
 */
export async function ensureSshMachineUsable(deviceId: string): Promise<boolean> {
  await sshMachinesReady()
  if (!isSshMachine(deviceId)) return false
  let problem: string | null = null
  subscribeSshLinkProblems((problems) => {
    problem = problems.get(deviceId) ?? null
  })()
  if (problem === 'signInRequired' || problem === 'hostKeyChanged' || problem === 'notSignedIn') {
    throw new SshLinkError(problem, deviceId)
  }
  return true
}
