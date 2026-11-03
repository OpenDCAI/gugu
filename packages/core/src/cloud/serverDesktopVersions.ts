/** Version validation and protocol parsing shared with released peers. No desktop selection or account state is stored. */
import { MIN_CLIENT_PROTOCOL, REMOTE_PROTOCOL_VERSION } from './serverMachineHealth'
export { compareServerVersions } from './serverVersionSelection'
export { VERSION_RETRY_RPC, VERSION_RESTART_RPC } from './serverMachineHealth'

const VERSION_RE = /^[0-9A-Za-z._-]{1,64}$/
const DESKTOP_ID_RE = /^[A-Za-z0-9:_-]{1,128}$/

export function isServerVersion(value: unknown): value is string {
  return typeof value === 'string' && VERSION_RE.test(value) && !value.startsWith('.')
}

/** 桌面随 taskhost.open 带来的那一段(形状不对 = null,❌ 带着半截往下走)。 */
export type DesktopHello = { id: string; version: string; protocol: number | null }

export function parseDesktopHello(value: unknown): DesktopHello | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  if (typeof row.id !== 'string' || !DESKTOP_ID_RE.test(row.id) || !isServerVersion(row.version)) return null
  const protocol = typeof row.protocol === 'number' && Number.isInteger(row.protocol) && row.protocol > 0 ? row.protocol : null
  return { id: row.id, version: row.version, protocol }
}

/**
 * 这台桌面说的协议在不在这一版 server 的兼容窗口里:[MIN_CLIENT_PROTOCOL, REMOTE_PROTOCOL_VERSION]。
 *  · 高于上沿 = 这一版 server 比这台桌面旧(不认得它会发的东西);
 *  · 低于下沿 = 这台桌面比这一版 server 要求的旧(它自己会显示「请更新这台电脑上的咕咕」)。
 * 两种都是版本信号;不报协议的老桌面 = 不知道,❌ 下结论。
 */
export function desktopProtocolOutsideWindow(
  protocol: number | null,
  window: { min: number; max: number } = { min: MIN_CLIENT_PROTOCOL, max: REMOTE_PROTOCOL_VERSION },
): boolean {
  if (protocol === null) return false
  return protocol < window.min || protocol > window.max
}
