/**
 * 系统设置里「咕咕的某项权限」那一页的直达地址 —— 全仓唯一一份(product spec)。
 *
 * 这些 URL 原本散在三处各写一遍:桌面壳的通知诊断、会话页主进程的「文件访问」、以及手机端
 * 走插件的那条路。散着的后果不是重复,是**改一处漏两处**:同一个「去系统里开这项权限」的动作,
 * 在三个入口上行为可以不一致,而谁都不会响。
 *
 * ⚠️ 这里只回答「去哪儿开」,不回答「现在开没开」。macOS 不给应用读通知授权与按文件夹的
 * 访问授权(Electron 无接口;node-mac-permissions 2.5.0 的 getAuthStatus 也没有这两档),
 * 所以桌面上这两项**读不到真值**、不进「权限」页 —— 那一页只列读得到的。
 */
export type SystemSettingsTarget = 'notifications' | 'fileAccess'

export type HostOs = 'mac' | 'win' | 'linux' | ''

const URLS: Record<SystemSettingsTarget, Partial<Record<HostOs, string>>> = {
  notifications: {
    mac: 'x-apple.systempreferences:com.apple.Notifications-Settings.extension',
    win: 'ms-settings:notifications',
  },
  fileAccess: {
    mac: 'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders',
  },
}

/** 没有可直达的入口就回 null —— 调用方据此退回文字指路,❌ 不要编一个地址出来。 */
export function systemSettingsUrl(target: SystemSettingsTarget, os: HostOs): string | null {
  return URLS[target][os] ?? null
}
