/**
 * #6264 每个账号跑和自己桌面匹配的那一份咕咕 server(product spec 第 5 条例外;照 VS Code
 * `~/.vscode-server/bin/<commit>` 多份并存、Zed `zed-remote-server-<版本>` 与客户端完全一致)。
 *
 *   versions/<版本>/          好几份并存:在用的 + 最近 5 份(VS Code 的做法,microsoft/vscode-remote-release#969)
 *   versions/.incoming/       上不了网的机器:桌面经 SSH 放进来的包 `<版本>.tar.gz` + 它的清单行 `<版本>.txt`,
 *                             守护进程装它而 ❌ 下载(装的仍只有守护进程一个,见 server-account-converge.ts)
 *   current                   守护进程自己跑的那一份;没有桌面报过版本的账号也跑它
 *   accounts/<id>/data/
 *     desktop-versions.json   用这台机器的各台桌面报的版本(core/cloud/serverDesktopVersions.ts)
 *     version-switch.json     版本信号来了:这个账号当场换,❌ 等空闲
 *     server-version.json     这个账号现在跑哪一版(守护进程写;账号进程从 versions/<它>/ 起)
 *
 * 规则(纯函数 planAccountVersion):目标 = 没过期的桌面报告里最新的、下载站上有的那一版;和在跑的不一样 ⇒
 * 没装就先装(下载、校验、试跑),装好了有版本信号就当场换、没有就等这个账号空闲再换。只重启这一个账号的进程,
 * 同一台机器上别的账号 ❌ 受影响。换过去秒退(起不来)就退回原来那一版,这一版几个小时内不再试。
 */
import fs from 'node:fs'
import path from 'node:path'
import { compareServerVersions, isServerVersion, pickTargetVersion, type DesktopReports } from '@gugu/core/cloud/serverDesktopVersions'

export const ACCOUNT_VERSION_FILE = 'server-version.json'
/** `gugu-server match-version` 打给桌面看的机器可读行(ssh-install/logic.ts 读)。 */
export const MATCH_MARK = '__GUGU_MATCH__'
/** 没人用的旧版本留几份(VS Code 同数)。 */
export const KEEP_RECENT_VERSIONS = 5

export type AccountVersionPin = { version: string; previous: string | null; at: number }

export function readAccountVersionPin(dataDir: string): AccountVersionPin | null {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dataDir, ACCOUNT_VERSION_FILE), 'utf8')) as Partial<AccountVersionPin>
    if (!isServerVersion(value.version)) return null
    return {
      version: value.version,
      previous: isServerVersion(value.previous) ? value.previous : null,
      at: typeof value.at === 'number' ? value.at : 0,
    }
  } catch {
    return null
  }
}

export function writeAccountVersionPin(dataDir: string, pin: AccountVersionPin): void {
  fs.mkdirSync(dataDir, { recursive: true })
  const file = path.join(dataDir, ACCOUNT_VERSION_FILE)
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(pin)}\n`, { mode: 0o600 })
  fs.renameSync(tmp, file)
}

export const versionBinary = (versionsDir: string, version: string): string => path.join(versionsDir, version, 'bin', 'gugu-server')

/** 桌面经 SSH 放进来的那一版的包与清单行(上不了网的机器;以 `.` 开头,清旧版本时不算一版)。 */
export const INCOMING_DIR = '.incoming'
export const incomingPackage = (versionsDir: string, version: string): { archive: string; manifest: string } => ({
  archive: path.join(versionsDir, INCOMING_DIR, `${version}.tar.gz`),
  manifest: path.join(versionsDir, INCOMING_DIR, `${version}.txt`),
})

/**
 * 这个账号该跑钉住的哪一版:钉了、不是守护进程自己那一版、而且装在盘上 = 那一版;否则 null = 跟着守护进程那一版。
 * converge 起账号进程(binaryFor)与升级看门狗判谁该跑新版本(server-upgrade-guard.ts readProbe)都按这一条。纯函数。
 */
export function pinnedVersionToRun(pin: AccountVersionPin | null, supervisorVersion: string, installed: (version: string) => boolean): string | null {
  return pin && pin.version !== supervisorVersion && installed(pin.version) ? pin.version : null
}

export type AccountVersionPlan =
  /** 没有桌面报过版本 / 已经是目标版本:什么也不做。 */
  | { kind: 'none'; clearSwitchRequest: boolean }
  /** 目标这一版刚失败过(冷却中):不再自己试,设备行说「更新没成功 · 重试」。 */
  | { kind: 'failed'; version: string }
  /** 目标版本还没装:先装。 */
  | { kind: 'stage'; version: string }
  /** 装好了、在等这个账号空闲(没有版本信号)。 */
  | { kind: 'wait-idle'; version: string }
  /** 现在就把这个账号换过去。 */
  | { kind: 'switch'; version: string; urgent: boolean }

/**
 * 一个账号这一轮该做什么。纯函数。
 * running:此刻这个账号的进程跑的是哪一版(没在跑 = 它下次会用的那一版)。
 */
export function planAccountVersion(input: {
  reports: DesktopReports
  now: number
  running: string | null
  switchRequested: boolean
  installed: (version: string) => boolean
  busy: boolean
  /** 这一版刚在这台机器上失败过(下载 / 试跑失败、换过去起不来):冷却中不再试。 */
  failed: (version: string) => boolean
  /** 报告全过期了(用它的桌面都很久没来):回到这台机器自己的版本(守护进程那一版,跟着自动升级走)。 */
  fallback?: string | null
  /** 下载站上没有的版本(刚 404 过、还没到再看的时刻):让位给次新的那一版。 */
  unpublished?: (version: string) => boolean
}): AccountVersionPlan {
  const target = pickTargetVersion(input.reports, input.now, undefined, input.unpublished) ?? input.fallback ?? null
  if (!target || target === input.running) return { kind: 'none', clearSwitchRequest: true }
  const failed = input.failed(target)
  if (!input.installed(target)) return failed ? { kind: 'failed', version: target } : { kind: 'stage', version: target }
  // 版本信号(桌面说的协议对不上,或桌面经 SSH 刚把这一版装好、请它换过去):当场换,冷却也不拦 —— 那是人那边在等。
  if (input.switchRequested) return { kind: 'switch', version: target, urgent: true }
  if (failed) return { kind: 'failed', version: target }
  return input.busy ? { kind: 'wait-idle', version: target } : { kind: 'switch', version: target, urgent: false }
}

/**
 * versions/ 下留哪些:正在被任一账号(以及守护进程自己)用的 + 最近用过的 KEEP_RECENT_VERSIONS 份(按目录的修改时刻,
 * 装好 / 换过去时都会刷新它)。以 `.` 开头的是下载中的临时目录,不归这里管。纯函数。
 */
export function versionsToKeep(input: {
  installed: ReadonlyArray<{ name: string; mtimeMs: number }>
  inUse: Iterable<string>
  recent?: number
}): Set<string> {
  const keep = new Set<string>()
  const inUse = new Set(input.inUse)
  const candidates = input.installed.filter((entry) => !entry.name.startsWith('.'))
  for (const entry of candidates) if (inUse.has(entry.name)) keep.add(entry.name)
  const rest = candidates
    .filter((entry) => !keep.has(entry.name))
    .sort((a, b) => b.mtimeMs - a.mtimeMs || compareServerVersions(b.name, a.name))
  for (const entry of rest.slice(0, input.recent ?? KEEP_RECENT_VERSIONS)) keep.add(entry.name)
  return keep
}

/** 按 versionsToKeep 清掉多出来的版本;返回删了哪些。 */
export function pruneVersions(versionsDir: string, inUse: Iterable<string>, recent = KEEP_RECENT_VERSIONS): string[] {
  let names: string[]
  try {
    names = fs.readdirSync(versionsDir)
  } catch {
    return []
  }
  const installed = names.flatMap((name) => {
    try {
      return [{ name, mtimeMs: fs.statSync(path.join(versionsDir, name)).mtimeMs }]
    } catch {
      return []
    }
  })
  const keep = versionsToKeep({ installed, inUse, recent })
  const removed: string[] = []
  for (const { name } of installed) {
    if (name.startsWith('.') || keep.has(name)) continue
    fs.rmSync(path.join(versionsDir, name), { recursive: true, force: true })
    removed.push(name)
  }
  return removed
}

/** 这一版刚被用上(装好 / 换过去):刷新目录时刻,「最近 5 份」按它排。 */
export function touchVersion(versionsDir: string, version: string, now = new Date()): void {
  try {
    fs.utimesSync(path.join(versionsDir, version), now, now)
  } catch {
    // 目录不在了:下一轮会重新装
  }
}

/** 这一版的清单:`<根>/<版本>/<os>-<arch>.txt`(发版时与通道清单一起写,见 scripts/gugu-server/publish-oss.cjs)。 */
export function versionManifestUrl(base: string, version: string, platform: string): string {
  return `${base}/${version}/${platform}.txt`
}
