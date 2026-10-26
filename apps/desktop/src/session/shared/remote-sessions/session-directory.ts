import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { isDeepEqual } from '@gugu/session-shared'
import type { Device } from '@gugu/core/shared/types/chat'
import { isPhoneDevice } from '@gugu/core/cloud/devices'
import type {
  SessionpageProjectSummary,
  SessionpageSessionSummary,
} from '@gugu/session-core/session-record/contract'
import type { SessionShellAgentName } from '@/session/shared/lib/ipc/shell-port'
import { useContactsStore } from '@/store/contactsContext'
import { sessionListFromDigest } from './session-list-sync'

/**
 * 跨机器的会话目录:每台机器上有哪些会话(行上带 agent 的 id)。手机与桌面共用这一份;每个端只有一个写者
 * (手机是壳根的同步 useAgentWatchAlerts,桌面是 remote-hosts-store),❌ 页面另订一份:两份订阅就是两份读数。
 * 离线机器读心跳摘要,读时现算,❌ 另存。
 */
export type DeviceSessions = {
  projects: readonly SessionpageProjectSummary[]
  sessions: readonly SessionpageSessionSummary[]
  /** 本地底稿,还没对过账:❌ 拿它比提醒、画页头。 */
  cached: boolean
  loading: boolean
  error: string | null
  /** Current transport evidence; a heartbeat alone cannot keep a working row live. */
  connected?: boolean
}

export type SessionDirectoryRow = { deviceId: string; session: SessionpageSessionSummary }

const EMPTY: DeviceSessions = { projects: [], sessions: [], cached: true, loading: true, error: null, connected: false }

// Shell and session renderer can be separate module graphs in the same document.
// Keep the single directory and its subscribers on that document, not in either bundle.
type DirectoryRetry = { ownerId: string; run: () => void | Promise<void> }
type DirectoryState = { devices: readonly Device[]; live: Readonly<Record<string, DeviceSessions>>; listeners: Set<() => void>; retries: Map<string, DirectoryRetry>; phoneReaders: number; demandListeners: Set<() => void> }
const DIRECTORY_KEY = '__GUGU_SESSION_DIRECTORY__' as const
const newDirectory = (): DirectoryState => ({ devices: [], live: {}, listeners: new Set(), retries: new Map(), phoneReaders: 0, demandListeners: new Set() })
const fallback = newDirectory()
function directoryState(): DirectoryState {
  if (typeof window === 'undefined') return fallback
  const host = window as Window & { [DIRECTORY_KEY]?: DirectoryState }
  const state = host[DIRECTORY_KEY] ??= newDirectory()
  state.retries ??= new Map()
  return state
}

/** Only the owning root can register its existing sync; pages never start another subscription. */
export function registerDeviceSessionsRetry(ownerId: string, deviceId: string, run: DirectoryRetry['run']): () => void {
  const retries = directoryState().retries
  const entry = { ownerId, run }
  retries.set(deviceId, entry)
  return () => { if (retries.get(deviceId) === entry) retries.delete(deviceId) }
}

/** A stale page from another account or a stopped device cannot reconnect that device. */
export async function retryDeviceSessions(ownerId: string, deviceId: string): Promise<void> {
  const entry = directoryState().retries.get(deviceId)
  if (!ownerId || !entry || entry.ownerId !== ownerId) throw new Error('当前账号没有这台设备的可重试连接。')
  await entry.run()
}

function publish(next: Readonly<Record<string, DeviceSessions>>): void {
  const state = directoryState()
  state.live = next
  for (const listener of state.listeners) listener()
}

export function updateDeviceSessions(deviceId: string, patch: Partial<DeviceSessions>): void {
  const live = directoryState().live
  const next = { ...(live[deviceId] ?? EMPTY), ...patch }
  // Equal polls preserve the directory and subscriber snapshots, regardless of JSON key order.
  if (live[deviceId] && isDeepEqual(live[deviceId], next)) return
  publish({ ...live, [deviceId]: next })
}

/** Only a mounted desktop task pane requests polling; leaving the pane releases the last reader. */
export function requestPhoneTaskDirectory(): () => void {
  const state = directoryState()
  state.phoneReaders += 1
  if (state.phoneReaders === 1) for (const listener of state.demandListeners) listener()
  let released = false
  return () => {
    if (released) return
    released = true
    state.phoneReaders -= 1
    if (state.phoneReaders === 0) for (const listener of state.demandListeners) listener()
  }
}

export function phoneTaskDirectoryRequested(): boolean { return directoryState().phoneReaders > 0 }
function subscribePhoneTaskDirectory(listener: () => void): () => void {
  const listeners = directoryState().demandListeners
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export function usePhoneTaskDirectoryRequested(): boolean {
  return useSyncExternalStore(subscribePhoneTaskDirectory, phoneTaskDirectoryRequested)
}
export function usePhoneTaskDirectory(): void { useEffect(requestPhoneTaskDirectory, []) }

/** The shell publishes its existing account device list across the two React roots. No workspace capability is implied. */
export function publishDirectoryDevices(devices: readonly Device[]): void {
  const state = directoryState()
  if (state.devices === devices) return
  state.devices = devices
  for (const listener of state.listeners) listener()
}

export function directoryDevices(): readonly Device[] {
  return directoryState().devices
}

export function useDirectoryDevices(): readonly Device[] {
  return useSyncExternalStore(subscribeDeviceSessions, directoryDevices)
}

/** Each synchronizer removes only the device it owns; computer cleanup must preserve phone summaries. */
export function removeDeviceSessions(deviceId: string): void {
  const live = directoryState().live
  if (!(deviceId in live)) return
  const { [deviceId]: _removed, ...remaining } = live
  publish(remaining)
}

/** 只留在线机器的格;在线的留着,重订期间页面不闪空。 */
export function retainDeviceSessions(deviceIds: readonly string[]): void {
  const live = directoryState().live
  const keep = Object.entries(live).filter(([id]) => deviceIds.includes(id))
  if (keep.length !== Object.keys(live).length) publish(Object.fromEntries(keep))
}

/** 不经 React 读与订(桌面的 MobX store 用)。 */
export function liveDeviceSessions(): Readonly<Record<string, DeviceSessions>> {
  return directoryState().live
}

export function subscribeDeviceSessions(listener: () => void): () => void {
  const listeners = directoryState().listeners
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useLiveDeviceSessions(): Readonly<Record<string, DeviceSessions>> {
  return useSyncExternalStore(subscribeDeviceSessions, liveDeviceSessions)
}

/**
 * 一台机器上的项目与会话:读到了那台机器此刻的就是它;没读到(离线、刚开还在读、一时连不上)就是它**自己上报过的那份** ——
 * 会话照心跳摘要,项目照账号上记着的那份(#113)列全(❌ 只列摘要里碰巧有会话的那几个;摘要里的会话所在的项目账号上
 * 没有,也照样列出,会话不能没有归处)。电脑的「上次的样子」只有这一份:设备行连同摘要本来就跟着设备列表存在本地,
 * ❌ 再另存一份会话底稿。在线时这一份标 cached(还没对过账,❌ 冒充此刻),读的进度与错误照实带上。
 */
export function deviceSessionsOf(device: Device, liveSessions: Readonly<Record<string, DeviceSessions>>): DeviceSessions {
  const live = liveSessions[device.device_id]
  if (device.is_online && live && (!live.cached || isPhoneDevice(device))) return live
  // 手机的目录由手机自己的记录铺(usePhoneAgentDirectory):摘要里没有 chatId(继续真实 DM 的地址),离线也照那一份。
  // 状态由行所在机器的在线信号决定,不把旧的 working 当此刻正在运行;完整 workspace 时间线仍然 unsupported。
  if (!device.is_online && isPhoneDevice(device) && live) return { ...live, cached: true, loading: false, error: null }
  const digest = sessionListFromDigest(device.session_digest, device.is_online)
  const recorded = (device.projects ?? []).map((project) => ({ id: project.localProjectId, name: project.name, path: project.rootPath }))
  const known = new Set(recorded.map((project) => project.id))
  const projects = [...recorded, ...digest.projects.filter((project) => !known.has(project.id))]
  return device.is_online
    ? { ...digest, projects, cached: true, loading: live?.loading ?? true, error: live?.error ?? null }
    : { ...digest, projects, cached: false, loading: false, error: null }
}

/** 全部机器的行;地址是行上的机器,❌ 人进的是哪台。 */
export function directoryRows(devices: readonly Device[], liveSessions: Readonly<Record<string, DeviceSessions>>): SessionDirectoryRow[] {
  return devices.flatMap((device) =>
    deviceSessionsOf(device, liveSessions).sessions.map((session) => ({ deviceId: device.device_id, session })))
}

/**
 * 这一行点不点得开(手机任务 tab 的行与 `gugu.showSession` 同一条):那台机器认得它(`supported`),或报了它的
 * 记录状态(新宿主,spec session-always-openable)。离线机器的行来自心跳摘要,两样都没有 ⇒ 点不开。
 */
export function rowOpens(session: SessionpageSessionSummary): boolean {
  return session.supported || session.recordState !== undefined
}

/**
 * 这条会话在目录里的那一行(手机任务 tab 点它进的就是这一行)。哪台都没列它时,给出没读到的那几台(在线却还在载、
 * 载失败):一台都没有 = 它不在这个人的任何一台机器上。`gugu.showSession` 在手机上按它答。
 */
export function listedSession(
  devices: readonly Device[],
  liveSessions: Readonly<Record<string, DeviceSessions>>,
  sessionId: string,
): { row: SessionDirectoryRow } | { unread: string[] } {
  const row = directoryRows(devices, liveSessions).find(({ session }) => session.conversationId === sessionId)
  if (row) return { row }
  const unread = devices.filter((device) => {
    if (!device.is_online) return false
    const listed = liveSessions[device.device_id]
    return !listed || listed.loading || listed.error !== null
  })
  return { unread: unread.map((device) => device.label) }
}

/**
 * agent 的显示名:只有云端 `identity.users` 这一份。手机上它已经在通讯录里(自己的 agent 全在、改名与新建跟着
 * `agent_changed` 重拉),行上只带 agent 的 id,按 id 对上即可 —— ❌ 再逐台机器问一遍名字。
 */
export function useAgentNames(): ReadonlyMap<string, string> {
  const { contacts } = useContactsStore()
  return useMemo(() => new Map(contacts.map((contact) => [contact.id, contact.display_name])), [contacts])
}

/** 这条会话背后的 agent(有身份、通讯录里有它);否则不给。 */
export function agentOfSession(session: SessionpageSessionSummary, agentNames: ReadonlyMap<string, string>): SessionShellAgentName | undefined {
  const userId = session.agent?.userId
  const displayName = userId ? agentNames.get(userId) : undefined
  return userId && displayName ? { conversationId: session.conversationId, displayName, agentUserId: userId } : undefined
}
