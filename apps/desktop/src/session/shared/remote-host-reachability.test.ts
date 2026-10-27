import { describe, expect, it } from 'vitest'
import { remoteHostReachable } from './remote-hosts'

describe('confirmed cloud state gates background task-host connections', () => {
  it.each(['asleep', 'waking'] as const)('does not dial %s even with a stale online heartbeat or tunnel', (cloudComputer) => {
    expect(remoteHostReachable({ isOnline: true, directTerminal: true, cloudComputer })).toBe(false)
  })
  it('keeps ordinary online and direct SSH hosts reachable', () => {
    expect(remoteHostReachable({ isOnline: true, directTerminal: false })).toBe(true)
    expect(remoteHostReachable({ isOnline: false, directTerminal: true })).toBe(true)
    expect(remoteHostReachable({ isOnline: true, directTerminal: false, cloudComputer: 'awake' })).toBe(true)
  })
})
