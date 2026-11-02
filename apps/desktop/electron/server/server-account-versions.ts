/** Package paths, explicit reclamation and read-only compatibility with deployed version pins. */
import fs from 'node:fs'
import path from 'node:path'
import { isServerVersion } from '@gugu/core/cloud/serverDesktopVersions'

/** Deployed supervisors wrote this pin; new runs retain its rollback package during migration. */
export const VERSION_PIN_FILE = 'server-version.json'
/** `gugu-server match-version` 打给桌面看的机器可读行(ssh-install/logic.ts 读)。 */
export const MATCH_MARK = '__GUGU_MATCH__'

export type VersionPin = { version: string; previous: string | null; at: number }

export function readVersionPin(dataDir: string): VersionPin | null {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dataDir, VERSION_PIN_FILE), 'utf8')) as Partial<VersionPin>
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

export function writeVersionPin(dataDir: string, pin: VersionPin): void {
  fs.mkdirSync(dataDir, { recursive: true })
  const file = path.join(dataDir, VERSION_PIN_FILE)
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
 * versions/ 下留哪些:正在被任一账号(以及守护进程自己)用的 + 明确传入的上一版(按目录的修改时刻,
 * 装好 / 换过去时都会刷新它)。以 `.` 开头的是下载中的临时目录,不归这里管。纯函数。
 */
export function versionsToKeep(input: {
  installed: ReadonlyArray<{ name: string; mtimeMs: number }>
  inUse: Iterable<string>
}): Set<string> {
  const keep = new Set<string>()
  const inUse = new Set(input.inUse)
  for (const entry of input.installed) {
    if (!entry.name.startsWith('.') && inUse.has(entry.name)) keep.add(entry.name)
  }
  return keep
}

/** 按 versionsToKeep 清掉多出来的版本;返回删了哪些。 */
export function pruneVersions(versionsDir: string, inUse: Iterable<string>, protectedNow: (version: string) => boolean = () => false): string[] {
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
  const keep = versionsToKeep({ installed, inUse })
  const removed: string[] = []
  for (const { name } of installed) {
    if (name.startsWith('.') || keep.has(name) || protectedNow(name)) continue
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
