/** Live account package identity; never substitute a pin or the installed package for a running process. */
import fs from 'node:fs'
import path from 'node:path'
import { isOwnProcessAlive, SERVER_PROCESS_MARK } from './process-alive'

/** 从 /proc/<pid>/environ 读 GUGU_TASK_HOST_VERSION(启动器 export 的),读不到退回命令行里的 versions/<版本>/。 */
export function runningVersionOf(pid: number, read: (file: string) => string | null): string | null {
  const environ = read(`/proc/${pid}/environ`)
  if (environ) {
    for (const entry of environ.split('\0')) {
      if (entry.startsWith('GUGU_TASK_HOST_VERSION=')) return entry.slice('GUGU_TASK_HOST_VERSION='.length) || null
    }
  }
  const cmdline = read(`/proc/${pid}/cmdline`)?.replace(/\0/g, ' ') ?? null
  return cmdline?.match(/\/versions\/([^/\s]+)\/(?:node|app)\//)?.[1] ?? null
}


const readText = (file: string): string | null => {
  try { return fs.readFileSync(file, 'utf8') } catch { return null }
}

export function readAccountRuntime(dataDir: string, deps: {
  read?: (file: string) => string | null
  alive?: (pid: number) => boolean
  now?: () => number
} = {}): { pid: number | null; version: string | null } {
  const read = deps.read ?? readText
  const alive = deps.alive ?? ((pid) => isOwnProcessAlive(pid, SERVER_PROCESS_MARK))
  const pid = Number(read(path.join(dataDir, 'server.lock'))?.trim())
  if (!Number.isInteger(pid) || pid <= 0 || !alive(pid)) return { pid: null, version: null }
  const version = runningVersionOf(pid, read)
  if (version) return { pid, version }
  // macOS has no /proc. Its heartbeat must belong to this live PID and still be fresh.
  try {
    const activity = JSON.parse(read(path.join(dataDir, 'activity.json')) ?? '') as { pid?: unknown; version?: unknown; at?: unknown }
    if (activity.pid === pid && typeof activity.version === 'string' && typeof activity.at === 'number' && (deps.now ?? Date.now)() - activity.at < 60_000) {
      return { pid, version: activity.version }
    }
  } catch { /* No verified account version yet. */ }
  return { pid, version: null }
}

export function installedPackageVersion(home: string): string | null {
  try { return path.basename(fs.realpathSync(path.join(home, 'current'))) } catch { return null }
}
