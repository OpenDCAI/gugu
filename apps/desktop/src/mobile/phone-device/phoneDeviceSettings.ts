/**
 * #7199 手机当设备 —— 用户在「我的 → 这台手机」里的选择:总开关(让云端的助理用这台手机)+ 每组一个开关。
 * 默认全关:❌ 装上就把手机交给云端。按账号分开存(同一台手机换个号登录,是另一台设备、另一套选择)。
 *
 * 存在这台手机的 WebView 里(localStorage):它只关这台手机自己,别的设备与云端读的是登记清单
 * (设备行 capabilities.actions),不是这份。读写失败(隐私模式、存储被清)就当全关 —— 宁可助理调不到,
 * ❌ 不能在人没开的情况下替他开着。
 */
import { useSyncExternalStore } from 'react'
import { PHONE_ACTION_GROUPS, type PhoneActionGroup, type PhoneGroupGrants } from './phoneActionCatalog'

export interface PhoneDeviceSettings {
  enabled: boolean
  groups: PhoneGroupGrants
}

const KEY_PREFIX = 'gugu.phoneDevice.v1:'
const INSTALL_KEY = 'gugu.phoneDevice.install'
/** 安装标识认的是哪台手机(原生给的 install_key);和这台对不上 = 从别的手机的备份里恢复来的。 */
const INSTALL_BOUND_KEY = 'gugu.phoneDevice.installBoundTo'

const allOff = (): PhoneGroupGrants =>
  Object.fromEntries(PHONE_ACTION_GROUPS.map((group) => [group, false])) as PhoneGroupGrants

export const DEFAULT_PHONE_DEVICE_SETTINGS: PhoneDeviceSettings = { enabled: false, groups: allOff() }

const listeners = new Set<() => void>()
const cache = new Map<string, PhoneDeviceSettings>()

function read(userId: string): PhoneDeviceSettings {
  const cached = cache.get(userId)
  if (cached) return cached
  let value = DEFAULT_PHONE_DEVICE_SETTINGS
  try {
    const raw = localStorage.getItem(KEY_PREFIX + userId)
    if (raw) {
      const parsed = JSON.parse(raw) as { enabled?: unknown; groups?: Record<string, unknown> }
      const groups = allOff()
      for (const group of PHONE_ACTION_GROUPS) groups[group] = parsed.groups?.[group] === true
      value = { enabled: parsed.enabled === true, groups }
    }
  } catch {
    value = DEFAULT_PHONE_DEVICE_SETTINGS
  }
  cache.set(userId, value)
  return value
}

function write(userId: string, next: PhoneDeviceSettings): void {
  cache.set(userId, next)
  try {
    localStorage.setItem(KEY_PREFIX + userId, JSON.stringify(next))
  } catch {
    // 存不下:这次会话里仍按新选择生效(cache),下次打开退回全关 —— 往安全的一侧偏。
  }
  for (const listener of [...listeners]) listener()
}

export function readPhoneDeviceSettings(userId: string | null): PhoneDeviceSettings {
  return userId ? read(userId) : DEFAULT_PHONE_DEVICE_SETTINGS
}

export function setPhoneDeviceEnabled(userId: string, enabled: boolean): void {
  write(userId, { ...read(userId), enabled })
}

export function setPhoneActionGroup(userId: string, group: PhoneActionGroup, on: boolean): void {
  const current = read(userId)
  write(userId, { ...current, groups: { ...current.groups, [group]: on } })
}

export function subscribePhoneDeviceSettings(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function usePhoneDeviceSettings(userId: string | null): PhoneDeviceSettings {
  return useSyncExternalStore(
    subscribePhoneDeviceSettings,
    () => readPhoneDeviceSettings(userId),
    () => DEFAULT_PHONE_DEVICE_SETTINGS,
  )
}

/** 这一组此刻对云端算不算开着:总开关与组开关都开。 */
export function groupGranted(settings: PhoneDeviceSettings, group: PhoneActionGroup): boolean {
  return settings.enabled && settings.groups[group]
}

export function effectiveGrants(settings: PhoneDeviceSettings): PhoneGroupGrants {
  const grants = allOff()
  for (const group of PHONE_ACTION_GROUPS) grants[group] = groupGranted(settings, group)
  return grants
}

/**
 * 这次安装的标识(machine_id):卸载重装才变。device_id 再按账号分开 —— 设备行的主键全库唯一,
 * 同一台手机换个号登录不能撞上上一个号的那一行。
 */
export function phoneInstallId(installKey: string | null = null): string {
  try {
    const existing = localStorage.getItem(INSTALL_KEY)
    const boundTo = localStorage.getItem(INSTALL_BOUND_KEY)
    // 网页存储会随系统备份搬到新手机:标识认的那台手机不是这台 ⇒ 换一个,❌ 两台手机共用一个设备行、同一次调用两边各做一遍。
    // 老安装没记过(boundTo 为空)⇒ 认下这台,标识不变(设备行不换)。
    if (existing && (!installKey || !boundTo || boundTo === installKey)) {
      if (installKey && !boundTo) localStorage.setItem(INSTALL_BOUND_KEY, installKey)
      return existing
    }
    const created = crypto.randomUUID()
    localStorage.setItem(INSTALL_KEY, created)
    if (installKey) localStorage.setItem(INSTALL_BOUND_KEY, installKey)
    return created
  } catch {
    throw new Error('这台手机存不下设备标识(localStorage 不可用),没法登记成设备')
  }
}

/**
 * ⚠️ 不能带冒号:设备 RPC 频道是 `gugu:{device_id}:rpc`,库放行时按冒号取第 2 段当 device_id
 * (realtime.messages 的 gugu_rpc_events_* 策略)。带冒号的 id 会被拆错 ⇒ 订频道被拒(真机实测)。
 */
export function phoneDeviceId(installId: string, userId: string): string {
  return `phone-${installId}-${userId}`
}

/** 这台手机此刻(这个账号)的 device_id;还没装过标识(从没打开过「这台手机」)= null,❌ 为了问一句就造一个。 */
export function thisPhoneDeviceId(userId: string): string | null {
  try {
    const installId = localStorage.getItem(INSTALL_KEY)
    return installId ? phoneDeviceId(installId, userId) : null
  } catch {
    return null
  }
}
