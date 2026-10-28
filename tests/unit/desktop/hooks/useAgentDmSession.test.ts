import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../../apps/desktop/src/hooks/useSessionpageAgentProjection', () => ({ useSessionpageAgentProjection: vi.fn() }))
vi.mock('../../../../apps/desktop/src/mobile/agent-watch/useAgentSessionRow', () => ({ useAgentSessionRow: vi.fn() }))

const { resolveAgentDmSession } = await import('../../../../apps/desktop/src/hooks/useAgentDmSession')

const base = {
  agentUserId: 'agent-1', deviceId: 'mac', devicesLoaded: true,
  device: { local: true, online: true },
  projection: { kind: 'pending', context: null, error: null },
  row: null, directory: null,
}

// The agent DM draws the agent's session record; when it cannot, it says which case it is (owner 10-27: no fallback
// to the old bubble list).
describe('resolveAgentDmSession', () => {
  it('local agent: the host mapping decides', () => {
    expect(resolveAgentDmSession(base)).toEqual({ state: 'resolving' })
    expect(resolveAgentDmSession({ ...base, projection: { kind: 'mapped', context: { sessionId: 's1' }, error: null } }))
      .toEqual({ state: 'ready', deviceId: 'mac', sessionId: 's1', local: true })
    expect(resolveAgentDmSession({ ...base, projection: { kind: 'unmapped', context: null, error: null } })).toEqual({ state: 'no-session' })
    expect(resolveAgentDmSession({ ...base, projection: { kind: 'error', context: null, error: 'boom' } })).toEqual({ state: 'failed', message: 'boom' })
  })

  it('agent on another computer: its session row, else offline / still reading / none', () => {
    const remote = { ...base, device: { local: false, online: true } }
    expect(resolveAgentDmSession({ ...remote, row: { deviceId: 'mac', sessionId: 's2' } }))
      .toEqual({ state: 'ready', deviceId: 'mac', sessionId: 's2', local: false })
    expect(resolveAgentDmSession({ ...remote, device: { local: false, online: false } })).toEqual({ state: 'machine-offline', deviceId: 'mac' })
    expect(resolveAgentDmSession({ ...remote, directory: { loading: true, error: null } })).toEqual({ state: 'resolving' })
    expect(resolveAgentDmSession({ ...remote, directory: { loading: false, error: 'link down' } })).toEqual({ state: 'failed', message: 'link down' })
    expect(resolveAgentDmSession({ ...remote, directory: { loading: false, error: null } })).toEqual({ state: 'no-session' })
  })

  it('does not call it "no session" before the device list has loaded', () => {
    expect(resolveAgentDmSession({ ...base, deviceId: null, device: null, devicesLoaded: false })).toEqual({ state: 'resolving' })
    expect(resolveAgentDmSession({ ...base, deviceId: null, device: null })).toEqual({ state: 'no-session' })
  })
})
