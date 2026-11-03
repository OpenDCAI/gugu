import { expect, it, vi } from 'vitest'
import { installServiceWith, type InstallServiceDeps, type RunningServer } from '../../../../apps/desktop/electron/server/server-service'

function machine(mode: InstallServiceDeps['mode'], supervisedBy: RunningServer['supervisedBy'] = 'none') {
  let current: RunningServer | null = { pid: 100, version: '1.0.0', supervisedBy }
  let alive = true, clock = 0, releaseAt = Infinity
  const events: string[] = []
  const register = () => {
    events.push('register')
    // Exit 78 is terminal: the manager cannot recover an initial lock collision.
    if (alive) current = null
    else current = { pid: 200, version: '2.0.0', supervisedBy: mode === 'launchd' ? 'launchd' : 'systemd' }
  }
  const deps = {
    mode, targetVersion: '2.0.0', running: () => current,
    isAlive: () => alive, isBusy: () => false,
    stop: () => { events.push('stop'); releaseAt = clock + 1000 },
    restart: vi.fn(() => { events.push('restart75'); alive = false; current = { pid: 200, version: '2.0.0', supervisedBy: 'systemd' } }),
    registerSystemd: register, registerLaunchd: register, registerCron: () => false,
    startDetached: vi.fn(), logHint: 'service.log', user: 'fixture', now: () => clock,
    sleep: async (ms: number) => {
      clock += ms
      if (clock >= releaseAt && alive) { alive = false; current = null; events.push('released') }
    },
  }
  return { deps, events, holdLock: () => { releaseAt = Infinity; deps.stop = () => { events.push('stop') } } }
}

it('requests exit 75 instead of an intentional stop when systemd is unreachable', async () => {
  const m = machine('systemdUnreachable', 'systemd')
  expect(await installServiceWith(() => {}, m.deps as InstallServiceDeps)).toBe(true)
  expect(m.events).toEqual(['restart75'])
})
it.each(['systemd', 'launchd'] as const)('waits for the outgoing lock before the first %s launch', async mode => {
  const m = machine(mode)
  expect(await installServiceWith(() => {}, m.deps as InstallServiceDeps)).toBe(true)
  expect(m.events).toEqual(['stop', 'released', 'register'])
})
it('does not register a manager while the outgoing server still owns the lock', async () => {
  const m = machine('systemd'); m.holdLock()
  expect(await installServiceWith(() => {}, m.deps as InstallServiceDeps)).toBe(false)
  expect(m.events).toEqual(['stop'])
})
