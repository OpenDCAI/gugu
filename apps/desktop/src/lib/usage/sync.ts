// 本机用量 → 云端(product spec「跨设备」)。只有桌面端有本地库和各家 CLI 的日志;
// 手机、网页只读云端。
//
// 什么时候同步:启动后一会儿、之后每 30 分钟一次、以及每次打开用量页。每台设备第一次同步
// 把本地能找到的历史全送上去(最多 400 天),之后只重算最近 8 天 —— 旧日子的数据不会再变,
// 而「今天」和「昨天」还在长(跨午夜的会话、晚到的 token 日志)。
import { platform } from '../../platform'
import { getCurrentAuthUserId } from '../supabase'
import { addDays, localDay } from './derive'
import { replaceDeviceRows } from './cloud'
import { snapshotToRows } from './rows'

const FULL_HISTORY_DAYS = 400
const RECENT_DAYS = 8
const MIN_INTERVAL_MS = 10 * 60_000
/**
 * 上云的行形状的版本。形状多了字段(例如 Token 分来源的 gugu_models / byok_models)时加一:
 * 老版本全量送上去的旧日子不会再被「最近 8 天」覆盖到,新字段在那些天会永远是空的 ——
 * 版本对不上就再全量送一次。
 */
const ROW_SHAPE_VERSION = 2

type SyncState = { fullAt?: number; lastAt?: number; shape?: number }

const stateKey = (userId: string, deviceId: string) => `gugu.usage.sync.${userId}.${deviceId}`

function readState(key: string): SyncState {
  try { return JSON.parse(localStorage.getItem(key) ?? '{}') as SyncState } catch { return {} }
}

export function canSyncLocalUsage(): boolean {
  return typeof platform.getLocalUsageSnapshot === 'function'
}

let inFlight: Promise<SyncResult> | null = null

export type SyncResult = 'unsupported' | 'throttled' | 'synced'

/**
 * 同一时刻只跑一份:启动那次还没完时用户点开用量页,等的是同一个 promise,
 * ❌ 不再并发第二份(两份各自 upsert + 删陈旧行会互相删掉对方刚写的)。
 */
export function syncLocalUsage(options: { force?: boolean } = {}): Promise<SyncResult> {
  if (!canSyncLocalUsage()) return Promise.resolve('unsupported')
  inFlight ??= run(options).finally(() => { inFlight = null })
  return inFlight
}

async function run({ force = false }: { force?: boolean }): Promise<SyncResult> {
  const userId = await getCurrentAuthUserId()
  const device = await platform.getLocalDeviceSelfSnapshot?.()
  if (!device?.device_id) return 'unsupported'
  const key = stateKey(userId, device.device_id)
  const state = readState(key)
  const now = Date.now()
  if (!force && state.lastAt && now - state.lastAt < MIN_INTERVAL_MS) return 'throttled'

  const to = localDay(new Date(now))
  const full = !state.fullAt || state.shape !== ROW_SHAPE_VERSION
  const from = addDays(to, -((full ? FULL_HISTORY_DAYS : RECENT_DAYS) - 1))
  const snapshot = await platform.getLocalUsageSnapshot!({ from, to })
  await replaceDeviceRows(snapshotToRows(snapshot, userId, device.device_id), device.device_id, from, to)
  localStorage.setItem(key, JSON.stringify({
    fullAt: full ? now : state.fullAt, lastAt: now, shape: ROW_SHAPE_VERSION,
  } satisfies SyncState))
  return 'synced'
}
