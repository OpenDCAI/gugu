/** Shared account version selection; consumed by local supervisors and official cloud hosts. */
/** 一台桌面多久没报就不再左右这个账号跑哪一版(开着窗口时每小时续一次)。 */
export const DESKTOP_REPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000
export type DesktopReport = {
  /** 这台桌面自己的咕咕版本(与 server 发版同一个版本号)。 */
  version: string
  /** 这台桌面说的桌面↔server 协议(serverMachineHealth.REMOTE_PROTOCOL_VERSION);老桌面不报 = null。 */
  protocol: number | null
  /** 最后一次报的时刻(毫秒)。 */
  at: number
}

/** 桌面 id → 它最后报的那一次。 */
export type DesktopReports = Record<string, DesktopReport>

/**
 * 两个版本号比大小:数字段逐段比(0.2.49 < 0.2.50 < 0.3.0);`-beta.3` 这类后缀里的数字段在主版本相同时再比。
 * 返回 >0 = a 更新。
 */
export function compareServerVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [main = '', suffix = ''] = v.split(/-(.*)/s)
    return { main: main.split('.').map((n) => Number(n) || 0), suffix: suffix.split(/[.-]/).map((n) => Number(n) || 0), hasSuffix: suffix !== '' }
  }
  const x = split(a)
  const y = split(b)
  for (let i = 0; i < Math.max(x.main.length, y.main.length); i += 1) {
    const d = (x.main[i] ?? 0) - (y.main[i] ?? 0)
    if (d !== 0) return d
  }
  // 同一个主版本:正式版比预发版新(0.3.0 > 0.3.0-beta.9),预发版之间按后缀里的数字比。
  if (x.hasSuffix !== y.hasSuffix) return x.hasSuffix ? -1 : 1
  for (let i = 0; i < Math.max(x.suffix.length, y.suffix.length); i += 1) {
    const d = (x.suffix[i] ?? 0) - (y.suffix[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/**
 * 这个账号该跑哪一版:没过期的报告里最新的那一版(同一账号几台桌面取最新,owner 选 A)。一台都没有 = null
 * (那就跟着这台机器自己的版本走,见 server-supervisor)。
 * unpublished:下载站上没有的版本(404)让位给次新的那一版 —— 一台桌面报了一个从没发布过的版本号
 * (没打后缀的测试包、老的开发实例),否则这个账号就钉在原地、每轮都去下载一次(2026-10-27 实撞)。
 */
export function pickTargetVersion(
  reports: DesktopReports,
  now: number,
  ttlMs = DESKTOP_REPORT_TTL_MS,
  unpublished: (version: string) => boolean = () => false,
): string | null {
  let best: string | null = null
  for (const report of Object.values(reports)) {
    if (now - report.at > ttlMs || unpublished(report.version)) continue
    if (best === null || compareServerVersions(report.version, best) > 0) best = report.version
  }
  return best
}

