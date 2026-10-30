/** Live account package identity; never substitute a pin or the installed package for a running process. */
import fs from 'node:fs'
import path from 'node:path'
import { isOwnProcessAlive, SERVER_PROCESS_MARK } from './process-alive'
import { runningVersionOf } from './server-version-match'

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
