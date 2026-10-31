import { parseSessionBootFailures } from '../shared/sessionBootTasks'
/**
 * #6264「设置 → 设备」每一行要写清楚的那几件事:这是一台什么机器(桌面 / 咕咕 server)、什么系统、
 * 什么架构、它自己的升级走到哪一步了。由那台机器自己随心跳报(心跳是 gugu_devices 行的唯一写者),
 * 放进 capabilities 这一格 jsonb —— 老宿主不报就是「不知道」,界面按缺席处理,❌ 不补默认值冒充事实。
 *
 * 纯函数与读盘分开:判定逻辑(系统名怎么拼、升级状态文件怎么读、多旧算过期)全部可单测;
 * 读 /etc/os-release、读状态文件这两件 IO 由 resolveDeviceHostInfo 注入。
 */
import { readFileSync, statfsSync } from 'node:fs'
import { arch as osArch, homedir as osHomedir, platform as osPlatform, release as osRelease } from 'node:os'
import { join } from 'node:path'
import type { DeviceHostInfo, DeviceServerDisk, DeviceServerRollback, DeviceServerUpdate } from '../shared/types/deviceHost'
import { MIN_CLIENT_PROTOCOL, REMOTE_PROTOCOL_VERSION, SERVER_ACTIVITY_STALE_MS } from './serverMachineHealth'
import { readServerConnectVia } from './serverConnectVia'
import { tunnelActiveAt, tunnelRelayUp } from './remoteTunnel'

/**
 * 咕咕 server 的守护进程把「升级走到哪了」写在这里(`<GUGU_SERVER_HOME>/data/` 下,
 * 见 apps/desktop/electron/server/server-updater.ts);每个账号的进程随心跳把它报上去。
 */
export const SERVER_UPDATE_STATE_FILE = 'server-update.json'

/** #6264 升级看门狗把「新版本没站稳、已退回」写在这里(apps/desktop/electron/server/server-upgrade-guard.ts)。 */
export const SERVER_ROLLBACK_FILE = 'server-rollback.json'
/** 退回这件事报多久:一周内还值得让人知道一声,再久就是旧闻。 */
export const SERVER_ROLLBACK_REPORT_MS = 7 * 24 * 60 * 60 * 1000
/**
 * #6264 守护进程每 30 秒写一次自己的版本与起始时刻(server-upgrade-guard.ts 的 writeSupervisorHealth)。
 * 账号进程钉在和桌面匹配的那一版上,自己的版本说明不了守护进程跑的是哪一版 —— 要知道就读这一份。
 */
export const SUPERVISOR_HEALTH_FILE = 'supervisor-health.json'

/** 「下载中」最多这么久不更新就当它已经不在下载了(守护进程可能半路没了)。 */
export const SERVER_UPDATE_DOWNLOADING_STALE_MS = 2 * 60 * 60 * 1000
/** 「就绪、等空闲」每 30 秒续写一次;超过这么久没续写 = 守护进程已不在等,不再报。 */
export const SERVER_UPDATE_READY_STALE_MS = 10 * 60 * 1000
/** #6264「更新没成功」守护进程每分钟续写;同样超过这么久没续写 = 它已不在,不再报。 */
export const SERVER_UPDATE_FAILED_STALE_MS = SERVER_UPDATE_READY_STALE_MS

/** darwin 内核主版本 → macOS 版本号。20→11(Big Sur)… 24→15;25 起苹果把版本号跳到 26(Tahoe)。 */
export function macosVersionFromDarwin(release: string): string | null {
  const major = Number(release.split('.')[0])
  if (!Number.isInteger(major) || major < 20) return null
  return String(major >= 25 ? major + 1 : major - 9)
}

/** /etc/os-release 里的 PRETTY_NAME(`Ubuntu 22.04.5 LTS`);没有就退回 NAME + VERSION_ID。 */
export function linuxNameFromOsRelease(text: string): string | null {
  const fields = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Z_]+)=(.*)$/)
    if (!match) continue
    fields.set(match[1], match[2].trim().replace(/^(["'])(.*)\1$/, '$2'))
  }
  const pretty = fields.get('PRETTY_NAME')
  if (pretty) return pretty
  const name = fields.get('NAME')
  if (!name) return null
  const version = fields.get('VERSION_ID')
  return version ? `${name} ${version}` : name
}

/** 给人看的系统名。认不出就 undefined(界面退回平台名),❌ 拿内核版本串冒充系统名。 */
export function describeOsName(input: { platform: string; release: string; osReleaseText: string | null }): string | undefined {
  if (input.platform === 'darwin') {
    const version = macosVersionFromDarwin(input.release)
    return version ? `macOS ${version}` : 'macOS'
  }
  if (input.platform === 'linux') {
    return (input.osReleaseText && linuxNameFromOsRelease(input.osReleaseText)) || 'Linux'
  }
  if (input.platform === 'win32') return 'Windows'
  return undefined
}

/**
 * 读守护进程写下的升级状态。认不出、过期、字段不全 ⇒ null(= 此刻没有在升级),
 * ❌ 不因为一个坏文件让心跳失败 —— 那会把整台机器显示成离线,拿主要的换次要的。
 */
export function parseServerUpdateState(text: string, nowMs: number, activityText?: string | null): DeviceServerUpdate | null {
  let data: { state?: unknown; version?: unknown; at?: unknown; reason?: unknown }
  try {
    data = JSON.parse(text) as typeof data
  } catch {
    return null
  }
  if (data.state !== 'downloading' && data.state !== 'ready' && data.state !== 'failed') return null
  if (typeof data.version !== 'string' || !data.version) return null
  if (typeof data.at !== 'number' || !Number.isFinite(data.at)) return null
  const age = nowMs - data.at
  const limit =
    data.state === 'downloading' ? SERVER_UPDATE_DOWNLOADING_STALE_MS : data.state === 'failed' ? SERVER_UPDATE_FAILED_STALE_MS : SERVER_UPDATE_READY_STALE_MS
  if (age > limit) return null
  const update: DeviceServerUpdate = { state: data.state, version: data.version }
  if ((data.state === 'ready' && data.reason === 'runtime-unverified') || (data.state === 'failed' && data.reason === 'boot-failed')) update.reason = data.reason
  if (data.state === 'ready' && activityText && !update.reason) {
    try {
      const activity = JSON.parse(activityText) as { at?: unknown; busyAgents?: unknown }
      if (typeof activity.at === 'number' && Number.isFinite(activity.at) && nowMs - activity.at >= 0 && nowMs - activity.at < SERVER_ACTIVITY_STALE_MS
        && typeof activity.busyAgents === 'number' && Number.isSafeInteger(activity.busyAgents) && activity.busyAgents >= 0) {
        update.busy_agents = activity.busyAgents
      }
    } catch { /* An unavailable activity count does not hide the update state. */ }
  }
  return update
}

/**
 * 读看门狗写的退回记录。认不出、过期 ⇒ null。
 * supervisorVersion = 守护进程此刻跑的那一版(❌ 账号进程自己的版本:它钉在桌面那一版上,和退回无关)。
 */
export function parseServerRollback(text: string, nowMs: number, supervisorVersion: string | undefined): DeviceServerRollback | null {
  let data: { version?: unknown; restored?: unknown; at?: unknown }
  try {
    data = JSON.parse(text) as typeof data
  } catch {
    return null
  }
  if (typeof data.version !== 'string' || !data.version || typeof data.restored !== 'string' || !data.restored) return null
  if (typeof data.at !== 'number' || nowMs - data.at > SERVER_ROLLBACK_REPORT_MS) return null
  // 守护进程后来已经升上去了(那个坏版本或更新的):这条记录说的已经不是现在的事。
  if (supervisorVersion && supervisorVersion !== data.restored) return null
  return { version: data.version, restored: data.restored }
}

/** 守护进程自己报的版本(supervisor-health.json);读不到 ⇒ undefined。 */
function supervisorVersionOf(text: string | null): string | undefined {
  try {
    const version = (JSON.parse(text ?? '') as { version?: unknown }).version
    return typeof version === 'string' && version ? version : undefined
  } catch {
    return undefined
  }
}

/** 数据目录所在的盘还剩多少(给非 root 用户用的那部分)。读不到 ⇒ null。 */
export function readDiskSpace(dir: string, statfs: (dir: string) => { bavail: number | bigint; blocks: number | bigint; bsize: number | bigint }): DeviceServerDisk | null {
  try {
    const stats = statfs(dir)
    const bsize = Number(stats.bsize)
    const free = Number(stats.bavail) * bsize
    const total = Number(stats.blocks) * bsize
    if (!Number.isFinite(free) || !Number.isFinite(total) || total <= 0) return null
    return { free_bytes: Math.max(0, free), total_bytes: total }
  } catch {
    return null
  }
}

export type DeviceHostInfoDeps = {
  platform?: () => string
  release?: () => string
  arch?: () => string
  readText?: (path: string) => string | null
  nowMs?: () => number
  /** 这个进程的 uid(POSIX);Windows 没有 = undefined。 */
  uid?: () => number | undefined
  statfs?: (dir: string) => { bavail: number | bigint; blocks: number | bigint; bsize: number | bigint }
  /** 远程隧道的中转此刻通不通(账号进程里的端点报,见 cloud/remoteTunnel.ts)。 */
  tunnelRelayUp?: () => boolean
  /** 隧道 / 直连上最近一次有真流量的时刻(账号进程记,见 cloud/remoteTunnel.ts);没有 = null。 */
  tunnelActiveAt?: () => string | null
  homedir?: () => string
}

const defaultReadText = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

let cachedOsName: { key: string; value: string | undefined } | null = null

/** 系统名一个进程里不会变,只算一次(os-release 读盘只做一次)。 */
function osNameOnce(platform: string, release: string, readText: (path: string) => string | null): string | undefined {
  const key = `${platform}:${release}`
  if (cachedOsName?.key === key) return cachedOsName.value
  const value = describeOsName({
    platform,
    release,
    osReleaseText: platform === 'linux' ? (readText('/etc/os-release') ?? readText('/usr/lib/os-release')) : null,
  })
  cachedOsName = { key, value }
  return value
}

/**
 * 这台机器随心跳报的「我是谁」。
 *  · host_kind:咕咕 server 由它的入口置 GUGU_SERVER_MODE=1(apps/desktop/electron/server-entry.ts),其余都是桌面。
 *  · server_update:只有 server 报,读守护进程写的状态文件。
 */
export function resolveDeviceHostInfo(env: NodeJS.ProcessEnv = process.env, deps: DeviceHostInfoDeps = {}): DeviceHostInfo {
  const readText = deps.readText ?? defaultReadText
  const platform = (deps.platform ?? osPlatform)()
  const isServer = env.GUGU_SERVER_MODE === '1'
  const info: DeviceHostInfo = {
    host_kind: isServer ? 'server' : 'desktop',
    arch: (deps.arch ?? osArch)(),
  }
  const osName = osNameOnce(platform, (deps.release ?? osRelease)(), readText)
  if (osName) info.os_name = osName
  const homeDir = (deps.homedir ?? osHomedir)()
  if (homeDir) info.home_dir = homeDir
  // #6264 咕咕 server 以 root 跑 = 上面的智能体都以管理员身份跑、能改整台机器:设备列表如实标出来。
  if (isServer && (deps.uid ?? (() => process.getuid?.()))() === 0) info.runs_as_root = true
  // #7199 个人助理住的那台自己报一声:各端设备行一出现就认得它(❌ 等问到管家才知道,那之前会把机器名露给人)。
  if (isServer && env.GUGU_CLOUD_COMPUTER === '1') info.assistant_home = true
  const home = env.GUGU_SERVER_HOME?.trim()
  if (isServer && home) {
    const nowMs = (deps.nowMs ?? Date.now)()
    // #6264 这个账号自己在换到和桌面匹配的那一版(server-account-converge.ts 写在账号目录里)优先;没有再看整台机器的升级。
    const accountDir = env.GUGU_TASK_HOST_USER_DATA?.trim()
    const accountText = accountDir ? readText(join(accountDir, SERVER_UPDATE_STATE_FILE)) : null
    const text = readText(join(home, 'data', SERVER_UPDATE_STATE_FILE))
    const activityText = accountDir ? readText(join(accountDir, 'activity.json')) : null
    const accountUpdate = accountText ? parseServerUpdateState(accountText, nowMs, activityText) : null
    const update = accountUpdate ?? (text ? parseServerUpdateState(text, nowMs) : null)
    if (update) info.server_update = { ...update, scope: accountUpdate ? 'account' : 'supervisor' }
    try {
      const health = JSON.parse(readText(join(home, 'data', SUPERVISOR_HEALTH_FILE)) ?? '{}') as { confirmedRestart?: unknown; at?: unknown }
      if (health.confirmedRestart === true && typeof health.at === 'number' && nowMs - health.at >= 0 && nowMs - health.at < SERVER_ACTIVITY_STALE_MS) {
        info.server_confirmed_restart = true
      }
      const activity = JSON.parse(activityText ?? '{}') as { bootFailures?: unknown }
      const failures = parseSessionBootFailures(activity.bootFailures)
      if (failures.length) info.server_boot_failures = failures
    } catch { /* Optional diagnostics do not gate device liveness. */ }
    // #6264 磁盘余量:一次 statfs 系统调用,随 30 秒一次的心跳报。满了之后升级、保存、登录态续期都会失败,
    // 以前界面上什么都看不到(机器照样「在线」)。
    const disk = readDiskSpace(home, deps.statfs ?? statfsSync)
    if (disk) info.server_disk = disk
    const rollbackText = readText(join(home, 'data', SERVER_ROLLBACK_FILE))
    const rollback = rollbackText ? parseServerRollback(rollbackText, nowMs, supervisorVersionOf(readText(join(home, 'data', SUPERVISOR_HEALTH_FILE)))) : null
    if (rollback) info.server_rollback = rollback
    info.remote_protocol = REMOTE_PROTOCOL_VERSION
    info.min_client_protocol = MIN_CLIENT_PROTOCOL
    // #6264 远程 SSH / 远程隧道:设备列表据此标连法,机器上限据此数远程隧道那一档。
    // 一次小文件读,随 30 秒一次的心跳;没记 = 不报(= 远程隧道)。
    const via = readServerConnectVia(env.GUGU_TASK_HOST_USER_DATA, readText)
    if (via) info.connect_via = via.via
    if ((deps.tunnelRelayUp ?? tunnelRelayUp)()) info.tunnel_relay = 'frp'
    // #7199 云电脑的管家据此判「在用」(最近 10 分钟有真流量)。
    const activeAt = (deps.tunnelActiveAt ?? tunnelActiveAt)()
    if (activeAt) info.tunnel_active_at = activeAt
  }
  return info
}

/** 测试用:清掉系统名缓存。 */
export function resetDeviceHostInfoCacheForTest(): void {
  cachedOsName = null
}
