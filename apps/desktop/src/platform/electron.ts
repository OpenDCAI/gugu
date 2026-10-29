import { stageFileHandle } from '@gugu/core/shared/fileResolver'
import type { LocalUsageRequest, LocalUsageSnapshot } from '@gugu/core/shared/usage/dailyUsage'
import type { Device } from '@gugu/core/shared/types/chat'
import { normalizeDeviceRow } from '@gugu/core/cloud/devices'
import type { HumanAuthSession } from '@gugu/core'
import type { AppPlatform, FeedbackLogTail } from './types'
import { unavailableCapability } from './errors'
import { anchorDownload } from './anchorDownload'
import { systemSettingsUrl, type HostOs } from '../../shared/system-settings-urls'
import { detectHostOs } from '@shared/host-os'
import type { SystemPermission } from './types'

/** @@@host-os 系统探针只有 `@shared/host-os` 一条;这里只是把 'other' 翻成本地的 ''。 */
function hostOs(): HostOs {
  const kind = detectHostOs()
  return kind === 'other' ? '' : kind
}

/**
 * 桌面上「权限」页列哪几行:**这个系统有那一页可跳**才列(product spec)。
 * 状态读不到不是不列的理由 —— 读不到就写「查不到」;连设置页都没有才不列。
 */
export function desktopSystemPermissions(os: HostOs): SystemPermission[] {
  const rows: SystemPermission[] = []
  if (systemSettingsUrl('notifications', os)) rows.push('notifications')
  if (systemSettingsUrl('fileAccess', os)) rows.push('fileAccess')
  return rows
}

const DESKTOP_SYSTEM_PERMISSIONS: readonly SystemPermission[] = desktopSystemPermissions(hostOs())

function electronApi() {
  return window.electronAPI
}

function unavailable(feature: string): Error {
  return unavailableCapability(feature, 'electron')
}

/**
 * @@@2374 — 命令桥按域名通用。
 *
 * 原来这里是一张一域一分支的 switch,只写了 `auth`;`extensions` 落到 switch 外面返回
 * undefined,再被调用点的 `?.()` 吞掉 —— 于是会话页从来没告诉过主进程「extensions 域
 * 准备好了」,主进程每个扩展宿主动作都等到超时。加一个域就得记得加一个分支,而忘了
 * 不会有任何声音,这种形状迟早还会再咬一次。
 */

export const electronPlatform: AppPlatform = {
  kind: 'electron',
  documentTitle: '咕咕 Desktop',
  /**
   * 桌面**跳得到系统设置、但查不到状态**:macOS 不给应用读通知授权,按文件夹的访问授权
   * 也只能弹框要、不能查(Electron 无接口;node-mac-permissions 2.5.0 实测
   * getAuthStatus('notifications') 直接抛,它有的 full-disk-access 又不是咕咕需要的那一档)。
   * 所以这两行照列,状态如实是 unreadable ——「查不到,去系统设置看」,点一下直达。
   * ❌ 因为查不到就把整页藏掉:那是给「连设置都跳不到」的宿主(浏览器)准备的规矩。
   */
  systemPermissions: DESKTOP_SYSTEM_PERMISSIONS,
  capabilities: {
    directoryPicker: true,
    appVersion: true,
    appUpdates: true,
    agentRuntime: true,
    badge: true,
    clipboard: true,
    notifications: true,
    rendererCommandBridge: true,
    localHumanAuthSession: true,
    backgroundWatch: false,
    barcodeScan: false,
    sessionHost: true,
    externalFileOpen: true,
    logTail: true,
    appRelaunch: true,
    shareToApps: false,
  },
  async relaunchApp() {
    const api = electronApi()
    if (!api?.relaunchApp) throw unavailable('appRelaunch')
    await api.relaunchApp()
  },
  async syncResolvedLocale(locale) {
    const api = electronApi()
    if (!api?.syncResolvedLocale) throw unavailable('resolvedLocaleSync')
    await api.syncResolvedLocale(locale)
  },
  subscribeAppForeground(listener) {
    const api = electronApi()
    if (!api?.onAppForeground) throw unavailable('App foreground subscription')
    return api.onAppForeground(listener)
  },
  subscribeAppActive(listener) {
    const api = electronApi()
    if (!api?.subscribeAppActive) throw unavailable('App active subscription')
    return api.subscribeAppActive(listener)
  },
  subscribeLocalDeviceIdentified(listener) {
    const api = electronApi()
    if (!api?.subscribeLocalDeviceIdentified) throw unavailable('Local device identity subscription')
    return api.subscribeLocalDeviceIdentified(listener)
  },
  async selectDirectory() {
    const api = electronApi()
    if (!api?.selectDirectory) throw unavailable('Directory picker')
    return api.selectDirectory()
  },
  async checkForUpdates() {
    const api = electronApi()
    if (!api?.checkForUpdates) throw unavailable('Updates')
    return api.checkForUpdates()
  },
  updateState: async () => electronApi()?.updateState?.() ?? null, // @@@5837 见 main.ts updaterState
  async downloadUpdate() {
    const api = electronApi()
    if (!api?.downloadUpdate) throw unavailable('Updates')
    return api.downloadUpdate()
  },
  async installUpdate() {
    const api = electronApi()
    if (!api?.installUpdate) throw unavailable('Updates')
    return api.installUpdate()
  },
  async fetchChangelog() {
    const api = electronApi()
    if (!api?.fetchChangelog) throw unavailable('Release notes')
    return api.fetchChangelog()
  },
  async readLogTail() {
    const api = electronApi()
    if (!api?.getFeedbackLogTail) throw unavailable('Log tail')
    return (await api.getFeedbackLogTail()) as FeedbackLogTail
  },
  async getAppVersion() {
    const api = electronApi()
    return api?.getAppVersion ? api.getAppVersion() : ''
  },
  saveFile: anchorDownload,
  async openRemoteFile(file, filename) {
    const api = electronApi()
    if (!api?.invoke) throw unavailable('External file open')
    const id = await stageFileHandle(file, filename, command => api.invoke('files:stage', command))
    await api.invoke('files:stage-open', { id })
  },
  async writeClipboardText(value) {
    const api = electronApi()
    if (api?.writeClipboardText) {
      await api.writeClipboardText(value)
      return
    }
    await navigator.clipboard.writeText(value)
  },
  setBadge(count) {
    electronApi()?.setBadge(count)
  },
  setTrayBadgeEnabled(enabled) {
    electronApi()?.setTrayBadgeEnabled(enabled)
  },
  async scanQrCode() {
    throw unavailable('QR scan')
  },
  async showNotification(payload) {
    const api = electronApi()
    if (!api?.showNotification) throw unavailable('Notifications')
    return api.showNotification(payload)
  },
  // 桌面读不到 macOS / Windows 的通知授权真值(见 lib/notificationDiagnostics.ts),权限页不在桌面出现。
  async checkSystemPermission() {
    // 桌面查不到就是查不到 —— 如实回 unreadable,❌ 不猜一个 granted 让界面说谎。
    return 'unreadable'
  },
  async requestSystemPermission() {
    // 系统不给应用弹这两项的授权框,唯一的下一步是去系统设置(systemPermissionAction 也只会走那条)。
    throw unavailable('System permission prompt')
  },
  async openSystemPermissionSettings(permission) {
    // 「去系统里开这项权限」桌面也做得到,走的是全仓唯一那份地址表。
    // window.open 在 Electron 里被 main.ts 的 setWindowOpenHandler 接走 → shell.openExternal,
    // 自定义 scheme 照样走得通,不需要另开一条 IPC。
    if (permission !== 'notifications' && permission !== 'fileAccess') return false
    const url = systemSettingsUrl(permission, hostOs())
    if (!url) return false
    window.open(url)
    return true
  },
  async setBackgroundWatch() {
    // 桌面上没有这个概念:窗口最小化了进程照样在跑,连接不会被系统掐。
    throw unavailable('Background watch')
  },
  async shareToApps() {
    throw unavailable('Share to other apps')
  },
  async writeHumanAuthSession(session: HumanAuthSession) {
    const api = electronApi()
    if (!api?.writeHumanAuthSession) throw unavailable('Local human auth session')
    await api.writeHumanAuthSession(session)
  },
  async clearHumanAuthSession(reason: 'signed-out' | 'lost') {
    const api = electronApi()
    if (!api?.clearHumanAuthSession) throw unavailable('Local human auth session')
    await api.clearHumanAuthSession(reason)
  },
  notifyDeviceCommandsChanged() {
    const api = electronApi()
    if (!api?.notifyDeviceCommandsChanged) throw unavailable('Device runtime notification')
    api.notifyDeviceCommandsChanged()
  },
  notifyScheduledTasksChanged() {
    const api = electronApi()
    if (!api?.notifyScheduledTasksChanged) throw unavailable('Device runtime notification')
    api.notifyScheduledTasksChanged()
  },
  notifyOwnedAgentsChanged() {
    const api = electronApi()
    if (!api?.notifyOwnedAgentsChanged) throw unavailable('Owned agents change notification')
    api.notifyOwnedAgentsChanged()
  },
  getPathForFile(file) {
    return electronApi()?.getPathForFile(file) ?? ''
  },
  sendRendererCommandReady(domain) {
    const api = electronApi()
    // ❌ 不用 `?.()`:桥缺了要响亮地说,而不是让主进程那边干等到超时。
    if (!api?.rendererCmdReady) throw unavailable('Renderer command bridge')
    api.rendererCmdReady(domain)
  },
  sendRendererCommandResult(domain, reqId, result) {
    const api = electronApi()
    if (!api?.rendererCmdResult) throw unavailable('Renderer command bridge')
    api.rendererCmdResult(domain, reqId, result)
  },
  async getLocalUsageSnapshot(request: LocalUsageRequest): Promise<LocalUsageSnapshot> {
    const api = electronApi()
    if (!api?.invoke) throw unavailable('Local usage snapshot')
    return await api.invoke('usage.localDaily', request) as LocalUsageSnapshot
  },
  async getLocalDeviceSelfSnapshot(): Promise<Device | null> {
    const api = electronApi()
    if (!api?.getLocalDeviceSelfSnapshot) return null
    const raw = await api.getLocalDeviceSelfSnapshot()
    if (!raw) return null
    return normalizeDeviceRow(raw)
  },
  async getAgentCreationTools(): Promise<unknown> {
    const api = electronApi()
    if (!api?.getAgentCreationTools) throw unavailable('Agent creation tools')
    return api.getAgentCreationTools()
  },
  // @@@4526 ❌ 不走上面那种「桥上没有就静默 return」:那正是这张票的形状——本机足迹一个没释放,
  // UI 却照说 Agent deleted。在 Electron 上这半必须存在,缺了就是装配错误,fail loud。
  async releaseOwnedAgentLocalFootprint(agentUserId: string): Promise<void> {
    const api = electronApi()
    if (!api?.releaseOwnedAgentLocalFootprint) throw unavailable('Owned agent local footprint release')
    await api.releaseOwnedAgentLocalFootprint(agentUserId)
  },
  // @@@share-card-rename 同上,缺桥就是装配错误:静默 return 会让云端改了名、会话页还叫旧名,
  // 而那个「两页两个名字」正是这一半存在的理由。
  async renameOwnedAgentLocalFootprint(agentUserId: string, name: string): Promise<void> {
    const api = electronApi()
    if (!api?.renameOwnedAgentLocalFootprint) throw unavailable('Owned agent local footprint rename')
    await api.renameOwnedAgentLocalFootprint(agentUserId, name)
  },
}
