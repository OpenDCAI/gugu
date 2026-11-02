import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export const SERVER_BOOT_PROGRESS_FILE = 'server-boot-progress.json'
import { parseSearchProgress, SERVER_TRANSITION_STALE_MS, type SearchProgress } from './serverTransition'
export type ServerBootProgress = {
  pid: number
  bootId: string
  version: string
  at: number
  phase: 'migrating' | 'ready'
  done?: number
  total?: number
  search?: SearchProgress
}

/** Only the account writes this file; only its supervisor incorporates it into server-update.json. */
export function createServerBootReporter(env: NodeJS.ProcessEnv, deps: { pid?: number; now?: () => number } = {}) {
  const dir = env.GUGU_SERVER_MODE === '1' ? env.GUGU_TASK_HOST_USER_DATA?.trim() : undefined
  const version = env.GUGU_TASK_HOST_VERSION?.trim()
  const pid = deps.pid ?? process.pid
  const now = deps.now ?? Date.now
  let value: ServerBootProgress = { pid, bootId: randomUUID(), version: version ?? '', at: now(), phase: 'migrating' }
  return (patch: Partial<Pick<ServerBootProgress, 'phase' | 'done' | 'total' | 'search'>>): void => {
    if (!dir || !version) return
    value = { ...value, ...patch, at: now() }
    const file = path.join(dir, SERVER_BOOT_PROGRESS_FILE)
    const tmp = `${file}.${pid}.tmp`
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 })
      fs.renameSync(tmp, file)
    } catch { /* Progress must never prevent account boot or live writes. */ }
  }
}

let reporter: ReturnType<typeof createServerBootReporter> | undefined
export function reportServerBoot(patch: Parameters<ReturnType<typeof createServerBootReporter>>[0]): void {
  // server-entry applies the account environment after loading its CLI modules.
  ;(reporter ??= createServerBootReporter(process.env))(patch)
}

export function readServerBootProgress(dir: string, child: { pid?: number; startedAt: number }, version: string, now = Date.now()): ServerBootProgress | null {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dir, SERVER_BOOT_PROGRESS_FILE), 'utf8')) as ServerBootProgress
    if (value.pid !== child.pid || value.version !== version || typeof value.bootId !== 'string' || !value.bootId
      || (typeof value.at !== 'number' || !Number.isSafeInteger(value.at)) || value.at < child.startedAt || value.at > now + 5_000 || now - value.at > SERVER_TRANSITION_STALE_MS
      || (value.phase !== 'migrating' && value.phase !== 'ready')) return null
    return { ...value, search: parseSearchProgress(value.search) }
  } catch { return null }
}
