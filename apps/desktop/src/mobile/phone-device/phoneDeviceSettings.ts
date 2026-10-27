/**
 * Phone task hosting and per-category phone data consent are independent.
 * `enabled` retains the installation-bound consent gate for existing grants; the
 * UI enables it only with an explicit category choice. It never permits remote actions.
 */
import { useSyncExternalStore } from 'react'
import { PHONE_ACTION_GROUPS, type PhoneActionGroup, type PhoneGroupGrants } from './phoneActionCatalog'

export interface PhoneDeviceSettings {
  enabled: boolean
  /** Agent hosting is an independent opt-in; it never grants phone data access. */
  hostEnabled: boolean
  groups: PhoneGroupGrants
}

const KEY_PREFIX = 'gugu.phoneDevice.v1:'
const INSTALL_KEY = 'gugu.phoneDevice.install'
/** 安装标识认的是哪台手机(原生给的 install_key);和这台对不上 = 从别的手机的备份里恢复来的。 */
const INSTALL_BOUND_KEY = 'gugu.phoneDevice.installBoundTo'

const allOff = (): PhoneGroupGrants =>
  Object.fromEntries(PHONE_ACTION_GROUPS.map((group) => [group, false])) as PhoneGroupGrants

export const DEFAULT_PHONE_DEVICE_SETTINGS: PhoneDeviceSettings = { enabled: false, hostEnabled: false, groups: allOff() }

const listeners = new Set<() => void>()
const cache = new Map<string, PhoneDeviceSettings>()

function read(userId: string): PhoneDeviceSettings {
  const cached = cache.get(userId)
  if (cached) return cached
  let value = DEFAULT_PHONE_DEVICE_SETTINGS
  try {
    const raw = localStorage.getItem(KEY_PREFIX + userId)
    if (raw) {
      const parsed = JSON.parse(raw) as { enabled?: unknown; hostEnabled?: unknown; groups?: Record<string, unknown> }
      const groups = allOff()
      for (const group of PHONE_ACTION_GROUPS) groups[group] = parsed.groups?.[group] === true
      value = { enabled: parsed.enabled === true, hostEnabled: parsed.hostEnabled === true, groups }
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

export function setPhoneAgentHostEnabled(userId: string, hostEnabled: boolean): void {
  write(userId, { ...read(userId), hostEnabled })
}

export function setPhoneActionGroup(userId: string, group: PhoneActionGroup, on: boolean): void {
  const current = read(userId)
  write(userId, { ...current, groups: { ...current.groups, [group]: on } })
}

/** Connecting one category in the guide must not silently restore other disabled categories. */
export function connectPhoneActionGroupChoice(userId: string, group: PhoneActionGroup): void {
  const current = read(userId)
  const groups = current.enabled ? current.groups : allOff()
  write(userId, { ...current, enabled: true, groups: { ...groups, [group]: true } })
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

/** A phone task may use only explicitly selected, installation-bound categories. */
export function groupGranted(settings: PhoneDeviceSettings, group: PhoneActionGroup): boolean {
  return settings.enabled && settings.groups[group]
}

export function effectiveGrants(settings: PhoneDeviceSettings): PhoneGroupGrants {
  const grants = allOff()
  for (const group of PHONE_ACTION_GROUPS) grants[group] = groupGranted(settings, group)
  return grants
}

/** A restored installation carries presentation data, never consent for this native install. */
function clearInstallationChoices(): void {
  const owners = new Set(cache.keys())
  let failure: unknown
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index)
      if (key?.startsWith(KEY_PREFIX)) owners.add(key.slice(KEY_PREFIX.length))
    }
  } catch (error) { failure = error }
  for (const owner of owners) {
    const next = { enabled: false, hostEnabled: false, groups: allOff() }
    cache.set(owner, next)
    try { localStorage.setItem(KEY_PREFIX + owner, JSON.stringify(next)) }
    catch (error) { failure ??= error }
  }
  for (const listener of [...listeners]) listener()
  // Do not mark the new native binding as verified if old consent remains on disk.
  if (failure) throw failure
}

/** Legacy origin cache is a migration hint; the native host's committed registration takes precedence. */
export function cachedPhoneInstallation(): { cachedInstallId: string | null; cachedBinding: string | null } {
  return { cachedInstallId: localStorage.getItem(INSTALL_KEY), cachedBinding: localStorage.getItem(INSTALL_BOUND_KEY) }
}

/** Cache the native registration; a restored WebView cannot carry consent to another installation. */
export function phoneInstallId(installKey: string, registrationId: string, previousInstallKey?: string | null): string {
  if (!installKey?.trim() || !registrationId?.trim()) throw new Error('无法读取这台手机的原生设备登记。请更新手机安装包后重试。')
  try {
    const boundTo = localStorage.getItem(INSTALL_BOUND_KEY)
    if (boundTo !== installKey && (!previousInstallKey || boundTo !== previousInstallKey)) clearInstallationChoices()
    // An origin can cache the native result, but it can never choose or rotate the registration.
    localStorage.setItem(INSTALL_KEY, registrationId)
    localStorage.setItem(INSTALL_BOUND_KEY, installKey)
    return registrationId
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
