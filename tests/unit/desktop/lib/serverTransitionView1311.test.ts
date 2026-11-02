import { describe, expect, it } from 'vitest'
import { serverTransitionView } from '../../../../apps/desktop/src/lib/serverTransitionView'
import type { DeviceServerTransition } from '../../../../packages/core/src/shared/types/deviceHost'
const state = (phase: DeviceServerTransition['phase'] = 'ready'): DeviceServerTransition => ({ phase, request: 7, target: '0.3.1', at: Date.now(), pid: 22 })

describe('truthful restart feedback', () => {
  it('requires the new account RPC identity, not its version heartbeat or a successful status read', () => {
    expect(serverTransitionView({ transition: state(), pending: false, reachable: true }, undefined, false).phase).toBe('connecting')
    expect(serverTransitionView({ transition: state(), pending: false, reachable: true, connected: true }, undefined, false).phase).toBe('connected')
    expect(serverTransitionView({ transition: state(), pending: false, reachable: true, connected: true }, undefined, true).phase).toBe('connecting')
  })
  it('retains an operation through a transport outage, but does not hide the next distinct update', () => {
    expect(serverTransitionView({ transition: state('migrating'), pending: false, reachable: false }, undefined, true)).toMatchObject({ active: true, suppressRestart: true, phase: 'migrating' })
    expect(serverTransitionView({ transition: state(), pending: false, reachable: true, connected: true }, undefined, false, '0.3.2')).toMatchObject({ active: false, suppressRestart: false, phase: undefined })
    expect(serverTransitionView({ transition: state('rolledBack'), pending: false, reachable: true }, undefined, false)).toMatchObject({ active: false, suppressRestart: false, phase: 'rolledBack' })
  })
  it('waits for the authoritative first read and tolerates a host that explicitly lacks the new command', () => {
    expect(serverTransitionView({ transition: null, reachable: false, pending: false }, undefined, false).suppressRestart).toBe(true)
    expect(serverTransitionView({ transition: null, reachable: false, pending: false, supported: false }, undefined, false).suppressRestart).toBe(false)
  })
})
