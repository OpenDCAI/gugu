import type { DeviceServerTransition } from '@gugu/core/shared/types/deviceHost'
import type { ServerUpdateView } from './serverUpdateReadings'

/** A missing SSH observation does not turn a remembered in-progress switch back into Ready. */
export function serverTransitionView(reading: ServerUpdateView | undefined, heartbeat: DeviceServerTransition | undefined, linkProblem: boolean, updateVersion?: string) {
  const transition = reading?.reachable && !reading.pending ? reading.transition ?? undefined : reading?.transition ?? heartbeat
  const checking = !!reading && !reading.reachable && reading.supported !== false && !transition
  const active = reading?.pending === true || !!transition && ['accepted', 'stopping', 'starting', 'migrating'].includes(transition.phase)
  const oldOutcome = transition && ['ready', 'failed', 'rolledBack'].includes(transition.phase) && updateVersion && updateVersion !== transition.target
  const phase = oldOutcome ? undefined : reading?.pending || checking ? 'connecting' : transition?.phase === 'ready'
    ? reading?.connected && !linkProblem ? 'connected' : 'connecting' : transition?.phase
  const search = transition?.search?.state === 'running' ? transition.search : null
  return { transition, active, phase,
    suppressRestart: active || checking || (!oldOutcome && transition?.phase === 'ready'),
    searchPercent: search && search.total > 0 ? Math.floor(100 * search.done / search.total) : null }
}
