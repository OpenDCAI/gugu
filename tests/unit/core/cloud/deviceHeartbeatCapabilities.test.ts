import { describe, expect, test } from 'vitest'
import { syncDeviceHeartbeat, type DeviceHeartbeatOptions, type DeviceHeartbeatTableClient } from '@gugu/core'

function fixture() {
  let stored: Record<string, unknown> | null = null
  let failure = false
  const rows: Record<string, unknown>[] = []
  const methods: string[] = []
  const client = {
    from: () => ({
      upsert: (payload: never) => {
        const row = payload as Record<string, unknown>
        rows.push(row)
        methods.push('upsert')
        const error = failure ? { message: 'write failed' } : null
        if (!error) stored = { ...(stored ?? { capabilities: {} }), ...row }
        return Promise.resolve({ error })
      },
      update: (row: Record<string, unknown>) => ({
        eq: () => {
          rows.push(row)
          methods.push('update')
          const error = failure ? { message: 'write failed' } : null
          if (!error && stored) stored = { ...stored, ...row }
          return Object.assign(Promise.resolve({ error }), {
            select: async () => ({ error, data: error ? null : stored ? [{ runtimes: (stored.capabilities as { runtimes?: string[] })?.runtimes ?? null }] : [] }),
          })
        },
      }),
    }),
  } as unknown as DeviceHeartbeatTableClient
  const published = new Map<string, string>()
  let actions: string[] = []
  const beat = (metadata: Partial<DeviceHeartbeatOptions> = {}, env: NodeJS.ProcessEnv = {}) => syncDeviceHeartbeat(client, {
    userId: 'owner', deviceId: 'device', hostname: () => 'test', platform: () => 'linux',
    machineIdentifier: () => 'machine', capabilities: { terminals: [], runtimes: actions },
    hostInfo: () => ({ host_kind: 'server', os_name: 'Linux', arch: 'x64', home_dir: '/test' }),
    ...metadata,
  }, env, published)
  return { beat, rows, methods, published, setActions: (value: string[]) => { actions = value }, fail: (value: boolean) => { failure = value },
    replace: (value: Record<string, unknown> | null) => { stored = value }, stored: () => stored }
}

describe('device heartbeat capability registration', () => {
  test.each(['desktop', 'server', 'phone'] as const)('only a published desktop can choose a cloud package (%s)', async host_kind => {
    const f = fixture()
    const info = { hostInfo: () => ({ host_kind, os_name: 'Test', arch: 'x64', home_dir: '/test' }) }
    await f.beat(info, { GUGU_APP_VERSION: '0.2.58-beta.1052.1', GUGU_BUILD_DISTRIBUTION: 'published' })
    expect(f.rows[0].capabilities).toMatchObject(host_kind === 'desktop' ? { published_desktop_version: '0.2.58-beta.1052.1' } : {})
    if (host_kind !== 'desktop') expect(f.rows[0].capabilities).not.toHaveProperty('published_desktop_version')
    await f.beat(info, { GUGU_APP_VERSION: '999.0.0', GUGU_BUILD_DISTRIBUTION: 'local' })
    expect(f.rows[1].capabilities).not.toHaveProperty('published_desktop_version')
  })
  test('steady heartbeats write only current presence; capability changes register again', async () => {
    const f = fixture()
    await f.beat()
    await f.beat()
    expect(f.rows[0]).toHaveProperty('capabilities')
    expect(f.methods).toEqual(['upsert', 'update'])
    expect(Object.keys(f.rows[1]).sort()).toEqual(['last_seen_at', 'session_digest', 'status', 'updated_at'])
    f.setActions(['changed'])
    await f.beat()
    expect(f.rows[2].capabilities).toMatchObject({ runtimes: ['changed'] })
    expect(f.methods[2]).toBe('upsert')
  })

  test.each<Partial<DeviceHeartbeatOptions>>([
    { label: () => 'renamed' }, { hostname: () => 'renamed-host' },
    { platform: () => 'darwin' }, { machineIdentifier: () => 'replaced-machine' },
    { userId: 'other-owner' },
    { hostInfo: () => ({ host_kind: 'desktop', os_name: 'macOS', arch: 'arm64', home_dir: '/other' }) },
  ])('changed registration fields are not skipped: %j', async (metadata) => {
    const f = fixture()
    await f.beat()
    await f.beat(metadata)
    expect(f.methods).toEqual(['upsert', 'upsert'])
  })

  test('a changing session digest is sent on every steady heartbeat', async () => {
    const f = fixture()
    await f.beat()
    const session = { conversationId: 'task', projectId: 'project', projectName: 'Project', title: 'Busy task', harness: 'codex', agentStatus: 'running', lastInteractedAt: null, supported: true }
    await f.beat({ sessionDigest: () => [session], nowIso: () => '2026-10-25T12:00:00Z' })
    expect(f.methods).toEqual(['upsert', 'update'])
    expect(f.stored()).toMatchObject({ session_digest: [session], last_seen_at: '2026-10-25T12:00:00Z', updated_at: '2026-10-25T12:00:00Z', status: 'online' })
  })

  test.each([{ GUGU_TIER: 'beta' }, { GUGU_APP_VERSION: '0.2.58-test' }])('changed tier or version registers again: %j', async (env) => {
    const f = fixture()
    await f.beat()
    await f.beat({}, env)
    expect(f.methods).toEqual(['upsert', 'upsert'])
  })

  test.each([null, { capabilities: {} }])('repairs an externally missing or cleared registration: %j', async (row) => {
    const f = fixture()
    await f.beat()
    f.replace(row)
    await f.beat()
    expect(f.rows).toHaveLength(3)
    expect(f.methods).toEqual(['upsert', 'update', 'upsert'])
    expect(f.rows[1]).not.toHaveProperty('capabilities')
    expect(f.rows[2]).toHaveProperty('capabilities')
    expect(f.stored()?.capabilities).toMatchObject({ runtimes: [] })
  })

  test('unchanged heartbeats preserve another instance registration', async () => {
    const f = fixture()
    await f.beat()
    const other = { runtimes: ['other'], terminals: [], app_version: 'other' }
    f.replace({ capabilities: other })
    await f.beat()
    await f.beat()
    expect(f.rows.slice(1).every(row => !('capabilities' in row))).toBe(true)
    expect(f.stored()?.capabilities).toEqual(other)
  })

  test('a failed heartbeat invalidates the successful-registration memory and stays loud', async () => {
    const f = fixture()
    await f.beat()
    f.fail(true)
    await expect(f.beat()).rejects.toThrow('write failed')
    expect(f.published.size).toBe(0)
    f.fail(false)
    await f.beat()
    expect(f.rows.at(-1)).toHaveProperty('capabilities')
  })
})
