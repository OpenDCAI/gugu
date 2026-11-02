import type { DeviceServerTransition } from '@gugu/core/shared/types/deviceHost'
import type { ServerBootProgress } from '@gugu/core/cloud/serverBootProgress'
import type { AccountEvent, AccountState } from './server-account-machine'

/** Project supervisor facts; the account's heartbeat never owns the switch. */
export function accountTransition(previous: AccountState, state: AccountState, event: AccountEvent): DeviceServerTransition | undefined {
  let value = previous.transition
  if (event.type === 'tick' && event.request?.confirmed && event.request.at !== value?.request) {
    value = { request: event.request.at, target: event.request.target ?? event.target, phase: 'accepted', at: event.now }
  }
  if (!value) return undefined
  const outcome = state.lastOutcome
  if (outcome?.request === value.request) {
    const phase = outcome.kind === 'switched' ? 'ready' : outcome.kind === 'rolledBack' ? 'rolledBack'
      : outcome.kind === 'failed' || outcome.kind === 'refused' ? 'failed' : null
    if (phase && value.phase !== phase) value = { ...value, phase, at: event.now }
  }
  return value
}

export function withBootProgress(value: DeviceServerTransition, progress: ServerBootProgress, now: number): DeviceServerTransition {
  const changed = value.pid !== progress.pid || JSON.stringify(value.search) !== JSON.stringify(progress.search)
    || (progress.phase === 'migrating' && (value.phase === 'starting' || value.done !== progress.done || value.total !== progress.total))
  return { ...value, pid: progress.pid, at: changed ? now : value.at,
    ...(value.phase === 'starting' || value.phase === 'migrating'
      ? { phase: progress.phase === 'ready' ? 'starting' : 'migrating', done: progress.done, total: progress.total } : {}),
    ...(progress.search ? { search: progress.search } : {}) }
}
