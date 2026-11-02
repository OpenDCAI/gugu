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

/**
 * 这台桌面报给咕咕 server 的「我是哪一版」。正式发版时桌面与 server 同一个版本号,报的就是自己的版本(GUGU_APP_VERSION)。
 * 开发 / 测试:桌面(pnpm dev,package.json 的版本)与测试 server 包(GUGU_SERVER_VERSION 另打的号)对不上,
 * 按「严格等于桌面版本」会去找一个不存在的 server 包 —— GUGU_SERVER_MATCH_VERSION 覆盖它,
 * 但只在没打包(开发)或用了自定义下载源(测试站)时生效;打包出的正式版走正式下载站,一律忽略。
 * 不是发布流水线出的包(GUGU_BUILD_DISTRIBUTION=local:开发实例、本机打的测试包)不覆盖就 ❌ 报:它的版本号
 * (多半是 package.json 那个不带后缀的号)从没发布过 server 包,却按「正式版比同号 Beta 新」压过所有真桌面。
 */
export function reportedDesktopVersion(env: NodeJS.ProcessEnv, options: { packaged: boolean; published: boolean }): string | null {
  const override = env.GUGU_SERVER_MATCH_VERSION?.trim()
  const testing = !options.packaged || Boolean(env.GUGU_SERVER_DOWNLOAD_BASE?.trim())
  if (override && testing && isServerVersion(override)) return override
  if (!options.published) return null
  const own = env.GUGU_APP_VERSION?.trim()
  return isServerVersion(own) ? own : null
}
