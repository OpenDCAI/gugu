/**
 * #6264「server 和桌面版本不匹配时，当场换成匹配的版本，升降都算」(product spec 第 5 条例外,owner 2026-09-25)。
 *
 * 照 VS Code(`~/.vscode-server/bin/<commit>` 多份并存)/ Zed(server 版本与客户端完全一致):
 * 一台咕咕 server 上**每个账号**各跑和自己桌面匹配的那一份。「匹配」= 与这个账号的桌面同版本号(正式发版时
 * 桌面与 server 同一个版本号);同一账号几台桌面版本不同时取最新的那台(owner 选 A)。
 *
 * 这个账号用这台机器的桌面各报一声「我是哪一版」,记在账号自己的数据目录(`desktop-versions.json`):
 *  · 每次开会话页宿主的窗口(`taskhost.open` 带上 desktop,远程 SSH 与远程隧道同一条)时报,窗口开着每小时续一次;
 *  · 远程 SSH 的桌面替它换版本时(`gugu-server match-version`)也报。
 * 只算真在用这台机器的桌面:从没连过它的电脑 ❌ 左右它跑哪一版。多久没报就不算(DESKTOP_REPORT_TTL_MS)。
 *
 * 版本信号(桌面说的协议落在这一版的兼容窗口外)还会留一个换版请求(`version-switch.json`);
 * 守护进程(apps/desktop/electron/server/server-supervisor.ts)据此把这个账号换到目标版本 —— 有请求不看冷却,
 * 但有 agent 在跑照样等空闲,只有人点过「现在重启更新」的请求才当场换。纯函数与读写分开,读写只碰这两个小文件。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MIN_CLIENT_PROTOCOL, REMOTE_PROTOCOL_VERSION } from './serverMachineHealth'

export const DESKTOP_VERSIONS_FILE = 'desktop-versions.json'
export const VERSION_SWITCH_FILE = 'version-switch.json'

/** 窗口开着时多久续报一次。 */
export const DESKTOP_REPORT_REFRESH_MS = 60 * 60 * 1000

import { DESKTOP_REPORT_TTL_MS, type DesktopReports } from './serverVersionSelection'
export { DESKTOP_REPORT_TTL_MS, compareServerVersions, pickTargetVersion, type DesktopReport, type DesktopReports } from './serverVersionSelection'

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

export function parseDesktopReports(text: string | null): DesktopReports {
  if (!text) return {}
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return {}
  }
  const out: DesktopReports = {}
  if (!value || typeof value !== 'object') return out
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!DESKTOP_ID_RE.test(id) || !raw || typeof raw !== 'object') continue
    const row = raw as Record<string, unknown>
    if (!isServerVersion(row.version) || typeof row.at !== 'number' || !Number.isFinite(row.at)) continue
    const protocol = typeof row.protocol === 'number' && Number.isInteger(row.protocol) ? row.protocol : null
    out[id] = { version: row.version, protocol, at: row.at }
  }
  return out
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 })
  renameSync(tmp, file)
}

export function readDesktopReports(accountDataDir: string): DesktopReports {
  return parseDesktopReports(readText(join(accountDataDir, DESKTOP_VERSIONS_FILE)))
}

/** 记下一台桌面报的版本;过期很久的顺手清掉(一个账号换过多少台电脑,这个文件都不会无限长)。 */
export function recordDesktopReport(accountDataDir: string, hello: DesktopHello, now = Date.now()): DesktopReports {
  const reports = readDesktopReports(accountDataDir)
  for (const [id, report] of Object.entries(reports)) {
    if (now - report.at > 4 * DESKTOP_REPORT_TTL_MS) delete reports[id]
  }
  reports[hello.id] = { version: hello.version, protocol: hello.protocol, at: now }
  mkdirSync(accountDataDir, { recursive: true })
  writeJsonAtomic(join(accountDataDir, DESKTOP_VERSIONS_FILE), reports)
  return reports
}

/**
 * 留一个「换版」请求(版本信号来了):这个账号空闲时守护进程下一轮就换,不看冷却。
 * 有 agent 在跑时只有人点过「现在重启更新」(`confirmed`)才当场换 —— 换版要结束账号进程,在跑的那一轮跟着没了
 * (10-28 Linux 2:桌面升了一版来敲门,7 条车道正在跑的那一轮全断)。
 */
export function requestVersionSwitch(accountDataDir: string, reason: string, now = Date.now(), confirmed = false): void {
  mkdirSync(accountDataDir, { recursive: true })
  writeJsonAtomic(join(accountDataDir, VERSION_SWITCH_FILE), { reason: reason.slice(0, 200), at: now, ...(confirmed ? { confirmed: true } : {}) })
}

/** 人点的「现在重启更新」多久内算数:过了还没换成(守护进程没在跑、换版失败),❌ 让它在之后的某次换版里替人再拍一次板。 */
export const VERSION_SWITCH_CONFIRM_TTL_MS = 10 * 60 * 1000

/** 有没有「换版」请求;一天前的算作废(那时的版本信号早就不是现在的事了)。 */
export function readVersionSwitchRequest(
  accountDataDir: string,
  now = Date.now(),
): { reason: string; at: number; confirmed: boolean } | null {
  const text = readText(join(accountDataDir, VERSION_SWITCH_FILE))
  if (!text) return null
  try {
    const value = JSON.parse(text) as { reason?: unknown; at?: unknown; confirmed?: unknown }
    if (typeof value.at !== 'number' || now - value.at > 24 * 60 * 60 * 1000) return null
    return {
      reason: typeof value.reason === 'string' ? value.reason : '',
      at: value.at,
      confirmed: value.confirmed === true && now - value.at < VERSION_SWITCH_CONFIRM_TTL_MS,
    }
  } catch {
    return null
  }
}

/**
 * 账号进程这一侧:一台桌面经 taskhost.open 报了版本。记下来;它说的协议落在这一版的兼容窗口外 = 版本信号,
 * 顺手留一个「当场换」的请求。返回有没有留请求。非咕咕 server(桌面自己)什么也不做。
 * 记着的就是这一版、这个协议,而且还没到续报的时候 = 同一件事,什么也不写:被拒的旧桌面会一遍遍来开
 * (device-session-host.ts,mac1 实测空闲时每台 6–14 秒一次)。续报仍照开着的窗口那样一小时一次 ——
 * ❌ 让一直在敲门的桌面因为报告过期(DESKTOP_REPORT_TTL_MS)被当成不在了,那样守护进程就不再为它换回匹配的版本。
 */
export function noteDesktopHello(
  env: NodeJS.ProcessEnv,
  hello: DesktopHello,
  now = Date.now(),
): { recorded: boolean; switchRequested: boolean } {
  const dataDir = env.GUGU_SERVER_MODE === '1' ? env.GUGU_TASK_HOST_USER_DATA?.trim() : undefined
  if (!dataDir) return { recorded: false, switchRequested: false }
  const known = readDesktopReports(dataDir)[hello.id]
  if (known && known.version === hello.version && known.protocol === hello.protocol && now - known.at < DESKTOP_REPORT_REFRESH_MS) {
    return { recorded: true, switchRequested: false }
  }
  recordDesktopReport(dataDir, hello, now)
  if (!desktopProtocolOutsideWindow(hello.protocol)) return { recorded: true, switchRequested: false }
  requestVersionSwitch(dataDir, `desktop ${hello.id} ${hello.version} speaks protocol ${String(hello.protocol)}`, now)
  return { recorded: true, switchRequested: true }
}

/**
 * 设备行「更新没成功 · 重试」/「现在重启更新」那一下(设备 RPC,远程隧道经咕咕云、远程 SSH 经设备连接,只有人点才发):
 * 账号进程留一个比失败更晚、人确认过的换版请求,守护进程下一轮就不看冷却、也不等空闲,重新下载 / 换过去。
 * 老 server 不认 = unknown_method(它也不会报「更新没成功」)。
 */
export { VERSION_RETRY_RPC } from './serverMachineHealth'

/** 账号进程这一侧收到「重试」。非咕咕 server = false。 */
export function requestVersionRetry(env: NodeJS.ProcessEnv, now = Date.now()): boolean {
  const dataDir = env.GUGU_SERVER_MODE === '1' ? env.GUGU_TASK_HOST_USER_DATA?.trim() : undefined
  if (!dataDir) return false
  requestVersionSwitch(dataDir, 'retry from desktop', now, true)
  return true
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
