import type { DeviceServerTransition } from '../shared/types/deviceHost'

export const SERVER_TRANSITION_STALE_MS = 10 * 60_000
export type SearchProgress = NonNullable<DeviceServerTransition['search']>
export const SERVER_UPDATE_STATUS_MARK = '__GUGU_UPDATE__'
export const SERVER_TRANSITION_HEALTH_RPC = 'server.transition.health'
export type ServerUpdateSnapshot = { at: number; transition: DeviceServerTransition | null }

const nonnegative = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0
export function parseSearchProgress(value: unknown): SearchProgress | undefined {
  const s = value as Partial<SearchProgress> | null
  return s && ['running', 'complete', 'failed'].includes(s.state ?? '') && nonnegative(s.done) && nonnegative(s.total) && s.done <= s.total
    ? { state: s.state!, done: s.done, total: s.total } : undefined
}

export function parseServerTransition(value: unknown, now = Date.now()): DeviceServerTransition | null {
  const s = value as Partial<DeviceServerTransition> | null
  if (!s || !['accepted', 'stopping', 'starting', 'migrating', 'ready', 'failed', 'rolledBack'].includes(s.phase ?? '')
    || typeof s.target !== 'string' || !s.target || s.target.length > 64
    || !nonnegative(s.request) || !nonnegative(s.at) || s.at > now + 5_000 || now - s.at > SERVER_TRANSITION_STALE_MS) return null
  return { request: s.request, target: s.target, phase: s.phase!, at: s.at,
    ...(nonnegative(s.pid) && s.pid > 0 ? { pid: s.pid } : {}),
    ...(nonnegative(s.done) && nonnegative(s.total) && s.done <= s.total ? { done: s.done, total: s.total } : {}),
    ...(parseSearchProgress(s.search) ? { search: parseSearchProgress(s.search) } : {}) }
}
