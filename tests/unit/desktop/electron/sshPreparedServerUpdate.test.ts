import { describe, expect, it, vi } from 'vitest'
import type { DeviceCapabilities } from '@gugu/core/shared/types/chat'
import { VERSION_RESTART_RPC, VERSION_RETRY_RPC, LEGACY_VERSION_RETRY_RPC } from '@gugu/core/cloud/serverMachineHealth'
import { createSshAutoUpgrader, sshServerUpgradeRunner } from '../../../../apps/desktop/electron/server/ssh-install/auto-upgrade'

const ready: DeviceCapabilities = { server_confirmed_restart: true, server_update: { state: 'ready', version: '2.0.0' } }
const state = (request: number, kind: 'waiting' | 'switched' | 'failed' | 'refused' | 'rolledBack'): DeviceCapabilities => ({ server_update: { state: 'idle', version: '2.0.0', lastOutcome: { request, kind } } })
function fixture(initial: DeviceCapabilities = ready, next: DeviceCapabilities[] = [state(42, 'switched')]) {
  let reads = 0
  let clock = 0
  const call = vi.fn(async () => ({ result: { requested: true, at: 42 } }))
  const spawnSsh = vi.fn(async () => { throw new Error('A prepared update must use the shared device RPC pipe') })
  const readCapabilities = vi.fn(async () => reads++ === 0 ? initial : next.shift() ?? state(41, 'switched'))
  const run = sshServerUpgradeRunner({ targetFor: async () => ({ destination: 'machine', display: 'machine' }),
    currentUserId: async () => 'owner', controlPath: () => null, channel: 'stable', call, spawnSsh, readCapabilities,
    now: () => clock, sleep: async ms => { clock += ms } })
  return { call, spawnSsh, readCapabilities, run: (now = true) => run('device', () => undefined, { now }) }
}
describe('SSH prepared updates share installation controls and A7 outcomes', () => {
  it('confirms the shown target and waits through unrelated and waiting heartbeats before completing', async () => {
    const f = fixture(ready, [state(41, 'switched'), state(42, 'waiting'), state(42, 'switched')])
    const result = await f.run()
    expect(f.call).toHaveBeenCalledExactlyOnceWith('device', VERSION_RESTART_RPC, { version: '2.0.0', confirmed: true }, { timeoutMs: 15_000 })
    expect(f.spawnSsh).not.toHaveBeenCalled()
    expect(f.readCapabilities).toHaveBeenCalledTimes(4)
    expect(result?.failure).toBeNull()
    expect(result?.steps.find(step => step.id === 'service')).toMatchObject({ status: 'done', version: '2.0.0' })
  })
  it('an automatic retry cannot confirm or interrupt busy work', async () => {
    const f = fixture()
    expect((await f.run(false))?.failure?.reason).toBe('agentsRunning')
    expect(f.call).toHaveBeenCalledExactlyOnceWith('device', VERSION_RETRY_RPC, {}, { timeoutMs: 15_000 })
    expect(f.readCapabilities).toHaveBeenCalledOnce()
  })
  it.each(['failed', 'rolledBack', 'refused'] as const)('does not report %s as a completed switch', async kind => {
    const f = fixture(ready, [state(42, kind)])
    expect((await f.run())?.failure).toMatchObject({ reason: 'serviceFailed', detail: `Server update ${kind}` })
  })
  it('does not accept an acknowledgement as a successful switch', async () => {
    const f = fixture()
    f.call.mockResolvedValue({ result: { requested: true, at: Number.NaN } })
    expect((await f.run())?.failure?.reason).toBe('agentsRunning')
    expect(f.readCapabilities).toHaveBeenCalledOnce()
  })
  it('a different request cannot complete the update', async () => {
    const f = fixture(ready, [])
    expect((await f.run())?.failure).toMatchObject({ reason: 'serviceFailed', detail: expect.stringContaining('Timed out') })
  })
  it('a released account host uses its legacy control without inventing a receipt', async () => {
    const f = fixture({ server_update: { scope: 'account', state: 'ready', version: '2.0.0' } })
    f.call.mockResolvedValue({ result: { requested: true, at: Number.NaN } })
    expect((await f.run())?.failure?.reason).toBe('agentsRunning')
    expect(f.call).toHaveBeenCalledExactlyOnceWith('device', LEGACY_VERSION_RETRY_RPC, {}, { timeoutMs: 15_000 })
  })
  it('a supervisor without confirmation support continues to wait', async () => {
    const f = fixture({ server_update: { scope: 'supervisor', state: 'ready', version: '2.0.0' } })
    expect((await f.run())?.failure?.reason).toBe('agentsRunning')
    expect(f.call).not.toHaveBeenCalled(); expect(f.spawnSsh).not.toHaveBeenCalled()
  })
  it('a client_outdated signal asks this desktop to update and never changes the server', () => {
    const run = vi.fn()
    const emit = vi.fn()
    const upgrader = createSshAutoUpgrader({ run, emit })
    expect(upgrader.request('device', { desktopTooOld: true })).toBe(false)
    expect(run).not.toHaveBeenCalled(); expect(emit).toHaveBeenCalledWith({ deviceId: 'device', phase: 'desktopTooOld' })
  })
})
