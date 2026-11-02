import type { LocalUsageRequest, LocalUsageSnapshot } from './dailyUsage'
import { snapshotToRows, type UsageDailyRow } from './rows'

export const USAGE_FIRST_DELAY_MS = 30_000
export const USAGE_SYNC_INTERVAL_MS = 30 * 60_000
const MIN_INTERVAL_MS = 10 * 60_000
const ROW_SHAPE_VERSION = 2
export type UsageSyncState = { fullAt?: number; lastAt?: number; shape?: number }
export type UsageSyncIdentity = { userId: string; deviceId: string }
export type UsageSyncResult = 'unsupported' | 'throttled' | 'synced'
export interface UsageSyncDependencies {
  identity(): Promise<UsageSyncIdentity | null>
  readState(key: string): UsageSyncState | Promise<UsageSyncState>
  writeState(key: string, state: UsageSyncState): void | Promise<void>
  snapshot(request: LocalUsageRequest): Promise<LocalUsageSnapshot>
  replaceRows(rows: UsageDailyRow[], deviceId: string, from: string, to: string): Promise<void>
  now?: () => number
}
function localDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
function fromDay(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number)
  return localDay(new Date(y, m - 1, d - days + 1, 12))
}

/** One device owns its rows; successful full syncs survive process restarts. */
export function createUsageSync(deps: UsageSyncDependencies): (options?: { force?: boolean }) => Promise<UsageSyncResult> {
  let inFlight: Promise<UsageSyncResult> | null = null
  async function run({ force = false }: { force?: boolean }): Promise<UsageSyncResult> {
    const identity = await deps.identity()
    if (!identity) return 'unsupported'
    const { userId, deviceId } = identity
    const key = `gugu.usage.sync.${userId}.${deviceId}`
    const state = await deps.readState(key)
    const now = deps.now?.() ?? Date.now()
    if (!force && state.lastAt && now - state.lastAt < MIN_INTERVAL_MS) return 'throttled'
    const to = localDay(new Date(now))
    const full = !state.fullAt || state.shape !== ROW_SHAPE_VERSION
    const from = fromDay(to, full ? 400 : 8)
    const snapshot = await deps.snapshot({ from, to })
    const current = await deps.identity()
    if (current?.userId !== userId || current.deviceId !== deviceId) throw new Error('Usage sync owner changed')
    await deps.replaceRows(snapshotToRows(snapshot, userId, deviceId), deviceId, from, to)
    await deps.writeState(key, { fullAt: full ? now : state.fullAt, lastAt: now, shape: ROW_SHAPE_VERSION })
    return 'synced'
  }
  return (options = {}) => {
    inFlight ??= run(options).finally(() => { inFlight = null })
    return inFlight
  }
}
