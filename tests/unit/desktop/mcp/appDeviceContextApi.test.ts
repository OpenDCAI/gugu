import { describe, expect, it } from 'vitest'
import { callRefusal } from '../../../../apps/desktop/src/session/shared/extensions/bridge-protocol'
import { dispatchCallOf } from '../../../../apps/desktop/src/session/shared/extensions/app-dispatch-core'
import { HOST_CALLS } from '../../../../apps/desktop/src/session/shared/extensions/host-calls'
import { parseAgentSessionRequest } from '../../../../apps/desktop/electron/cross-machine-sessions'

const caller = { kind: 'app', deviceId: 'source', deviceLabel: 'source', extensionId: 'context', extensionName: 'Context' }
describe('device-targeted App API boundaries', () => {
  it('preserves the server argument and packs explicit device options without a task', () => {
    expect(HOST_CALLS.callProgram.pack('inspect', {}, 'tools')).toEqual({ name: 'inspect', arguments: {}, server: 'tools' })
    expect(HOST_CALLS.callProgram.pack('inspect', {}, { server: 'tools', device: 'device:target' })).toEqual({ name: 'inspect', arguments: {}, server: 'tools', device: 'device:target' })
    const action = { action: 'app_call', call_id: 'one', device_id: 'target', version: '1.0.0', method: 'callProgram', args: { name: 'inspect' } }
    expect(parseAgentSessionRequest('app_call', caller, action)).toMatchObject({ action })
    expect(parseAgentSessionRequest('app_call', caller, { ...action, session_id: 'ambiguous' })).toHaveProperty('error')
    expect(parseAgentSessionRequest('app_call', caller, { ...action, device_id: undefined })).toHaveProperty('error')
  })

  it('requires all-history for external transcripts and all-machines-control for named remote spawns', () => {
    const own = { kind: 'page' as const, has: (word: string) => word === 'agents:history' || word === 'agents:control' }
    expect(callRefusal('sessionsIndex', {}, own)).toMatchObject({ code: 'denied' })
    expect(callRefusal('sessionsRead', {}, own)).toMatchObject({ code: 'denied' })
    const args = { text: 'inspect', to: { new: true }, spawn: { device: 'device:target' } }
    expect(dispatchCallOf(args).spawn.device).toBe('device:target')
    expect(callRefusal('dispatch', args, own)).toMatchObject({ code: 'denied' })
    expect(callRefusal('dispatch', args, { kind: 'page', has: (word) => word === 'agents:control:all-machines' })).toBeNull()
    expect(() => dispatchCallOf({ ...args, spawn: { device: 'session:wrong-kind' } })).toThrow(/device/)
  })
})
