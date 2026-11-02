import { describe, expect, it, vi } from 'vitest'
import { parseServerUpdateState, resolveDeviceHostInfo } from '../../../../packages/core/src/cloud/deviceHostInfo'
import { normalizeDeviceRow } from '../../../../packages/core/src/cloud/devices'
import { SERVER_ACTIVITY_STALE_MS } from '../../../../packages/core/src/cloud/serverMachineHealth'

vi.mock('../../../../packages/core/src/cloud/remoteTunnel', () => ({ REMOTE_TUNNEL_OPEN: false, tunnelRelayUp: () => false, tunnelActiveAt: () => null }))

const now = 1_000_000
const ready = JSON.stringify({ state: 'ready', version: '0.2.58-beta.1057.1', at: now })
const activity = (busyAgents: unknown, at = now) => JSON.stringify({ busyAgents, at })

describe('server update activity reported by the account that is waiting', () => {
  it('reports fresh counts including a known zero, without changing the target version', () => {
    expect(parseServerUpdateState(ready, now, activity(3))).toMatchObject({ version: '0.2.58-beta.1057.1', busy_agents: 3 })
    expect(parseServerUpdateState(ready, now, activity(0))).toMatchObject({ busy_agents: 0 })
  })

  it.each([undefined, '{bad', activity(-1), activity(1.5), activity('3'), activity(2, now + 1), activity(2, now - SERVER_ACTIVITY_STALE_MS)])(
    'keeps a valid ready state when its activity count is unknown (%s)', (text) => {
      expect(parseServerUpdateState(ready, now, text)).toEqual({ state: 'ready', version: '0.2.58-beta.1057.1' })
    },
  )

  it('does not attach a count to a download or failure', () => {
    for (const state of ['downloading', 'failed']) {
      expect(parseServerUpdateState(JSON.stringify({ state, version: 'target', at: now }), now, activity(3))).toEqual({ state, version: 'target' })
    }
  })

  it('reads only the installation update while using the single account's activity', () => {
    const files: Record<string, string> = {
      '/srv/accounts/u/data/server-update.json': ready,
      '/srv/accounts/u/data/activity.json': activity(2),
      '/srv/data/server-update.json': ready,
    }
    const env = { GUGU_SERVER_MODE: '1', GUGU_SERVER_HOME: '/srv', GUGU_TASK_HOST_USER_DATA: '/srv/accounts/u/data' }
    const deps = { platform: () => 'linux', release: () => '6', arch: () => 'x64', uid: () => 1000, homedir: () => '/home/user', nowMs: () => now,
      readText: vi.fn((path: string) => files[path] ?? null), statfs: () => ({ bavail: 10, blocks: 20, bsize: 4096 }) }
    expect(resolveDeviceHostInfo(env, deps).server_update).toMatchObject({ busy_agents: 2 })
    expect(deps.readText).not.toHaveBeenCalledWith('/srv/accounts/u/data/server-update.json')
    delete files['/srv/accounts/u/data/server-update.json']
    expect(resolveDeviceHostInfo(env, deps).server_update).toEqual({ state: 'ready', version: '0.2.58-beta.1057.1', busy_agents: 2 })
  })
  it('reports fresh supervisor capability and the existing activity failure ledger', () => {
    const files: Record<string, string> = {
      '/srv/data/supervisor-health.json': JSON.stringify({ at: now, confirmedRestart: true }),
      '/srv/accounts/u/data/activity.json': JSON.stringify({ at: now, bootFailures: [{ operation: 'outbox-drain', taskId: 'bad', message: 'router failed' }] }),
    }
    const env = { GUGU_SERVER_MODE: '1', GUGU_SERVER_HOME: '/srv', GUGU_TASK_HOST_USER_DATA: '/srv/accounts/u/data' }
    const deps = { nowMs: () => now, readText: (file: string) => files[file] ?? null, uid: () => 1000 }
    expect(resolveDeviceHostInfo(env, deps)).toMatchObject({ server_confirmed_restart: true, server_boot_failures: [{ taskId: 'bad', operation: 'outbox-drain', message: 'router failed' }] })
    files['/srv/data/supervisor-health.json'] = JSON.stringify({ at: now - SERVER_ACTIVITY_STALE_MS, confirmedRestart: true })
    expect(resolveDeviceHostInfo(env, deps).server_confirmed_restart).toBeUndefined()
  })

  it('clears only the supervisor-ready notice for the version this account already runs', () => {
    const env = { GUGU_SERVER_MODE: '1', GUGU_SERVER_HOME: '/srv', GUGU_APP_VERSION: '0.2.58-beta.1057.1' }
    let update = ready
    const deps = { nowMs: () => now, readText: (file: string) => file === '/srv/data/server-update.json' ? update : null, uid: () => 1000 }
    expect(resolveDeviceHostInfo(env, deps).server_update).toBeUndefined()
    update = JSON.stringify({ state: 'ready', version: '0.2.58-beta.1058.1', at: now })
    expect(resolveDeviceHostInfo(env, deps).server_update).toMatchObject({ state: 'ready', version: '0.2.58-beta.1058.1' })
    update = JSON.stringify({ state: 'failed', version: env.GUGU_APP_VERSION, at: now })
    expect(resolveDeviceHostInfo(env, deps).server_update).toMatchObject({ state: 'failed', version: env.GUGU_APP_VERSION })
  })

})


describe('installation request outcomes in device heartbeats', () => {
  it.each(['switched', 'rolledBack', 'failed', 'refused', 'waiting'] as const)('preserves the existing %s result through the heartbeat and device normalization', kind => {
    const lastOutcome = { kind, request: 1234 }
    const account = JSON.stringify({ state: 'idle', version: '0.3.1', at: now,
      lastOutcome: { ...lastOutcome, at: now, target: '0.3.1', cause: 'boot' } })
    const env = { GUGU_SERVER_MODE: '1', GUGU_SERVER_HOME: '/srv', GUGU_TASK_HOST_USER_DATA: '/account' }
    const info = resolveDeviceHostInfo(env, { nowMs: () => now, uid: () => 1000,
      readText: file => file === '/srv/data/server-update.json' ? account : null })
    const device = normalizeDeviceRow({ device_id: 'remote', label: 'Remote', hostname: 'remote', platform: 'linux', status: 'online',
      last_seen_at: '2026-11-02T00:00:00Z', capabilities: info })
    expect(device.capabilities.server_update).toEqual({ state: 'idle', version: '0.3.1', lastOutcome })
  })

  it.each([null, {}, { kind: 'invented', request: 1234 }, { kind: 'failed', request: '1234' }, { kind: 'failed' }])('does not invent an acknowledgement from an invalid or automatic outcome (%j)', lastOutcome => {
    const account = JSON.stringify({ state: 'failed', version: '0.3.1', at: now, account: { lastOutcome } })
    expect(parseServerUpdateState(account, now)).toEqual({ state: 'failed', version: '0.3.1' })
  })
})
