import { describe, expect, it, vi } from 'vitest'
import { parseServerUpdateState, resolveDeviceHostInfo } from '../../../../packages/core/src/cloud/deviceHostInfo'
import { SERVER_ACTIVITY_STALE_MS } from '../../../../packages/core/src/cloud/serverMachineHealth'

vi.mock('../../../../packages/core/src/cloud/remoteTunnel', () => ({ tunnelRelayUp: () => false, tunnelActiveAt: () => null }))

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

  it('reads the current account activity, and never attributes that count to a daemon-wide update', () => {
    const files: Record<string, string> = {
      '/srv/accounts/u/data/server-update.json': ready,
      '/srv/accounts/u/data/activity.json': activity(2),
      '/srv/data/server-update.json': ready,
    }
    const env = { GUGU_SERVER_MODE: '1', GUGU_SERVER_HOME: '/srv', GUGU_TASK_HOST_USER_DATA: '/srv/accounts/u/data' }
    const deps = { platform: () => 'linux', release: () => '6', arch: () => 'x64', uid: () => 1000, homedir: () => '/home/user', nowMs: () => now,
      readText: (path: string) => files[path] ?? null, statfs: () => ({ bavail: 10, blocks: 20, bsize: 4096 }) }
    expect(resolveDeviceHostInfo(env, deps).server_update).toMatchObject({ busy_agents: 2 })
    delete files['/srv/accounts/u/data/server-update.json']
    expect(resolveDeviceHostInfo(env, deps).server_update).toEqual({ state: 'ready', version: '0.2.58-beta.1057.1' })
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

})
