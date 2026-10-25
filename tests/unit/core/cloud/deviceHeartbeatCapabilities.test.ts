import { describe, expect, test } from 'vitest'
import { syncDeviceHeartbeat, type DeviceHeartbeatTableClient } from '@gugu/core'

function fixture() {
  let stored: Record<string, unknown> | null = null
  let failure = false
  const rows: Record<string, unknown>[] = []
  const client = {
    from: () => ({
      upsert: (payload: never) => {
        const row = payload as Record<string, unknown>
        rows.push(row)
        const error = failure ? { message: 'write failed' } : null
        if (!error) stored = { ...(stored ?? { capabilities: {} }), ...row }
        return Object.assign(Promise.resolve({ error }), {
          select: async () => ({ error, data: error ? null : [{ runtimes: (stored?.capabilities as { runtimes?: string[] })?.runtimes ?? null }] }),
        })
      },
    }),
  } as unknown as DeviceHeartbeatTableClient
  const published = new Map<string, string>()
  let actions: string[] = []
  const beat = () => syncDeviceHeartbeat(client, {
    userId: 'owner', deviceId: 'device', hostname: () => 'test', platform: () => 'linux',
    machineIdentifier: () => 'machine', capabilities: { terminals: [], runtimes: actions },
    hostInfo: () => ({ host_kind: 'server', os_name: 'Linux', arch: 'x64', home_dir: '/test' }),
  }, {}, published)
  return { beat, rows, published, setActions: (value: string[]) => { actions = value }, fail: (value: boolean) => { failure = value },
    replace: (value: Record<string, unknown> | null) => { stored = value }, stored: () => stored }
}

describe('device heartbeat capability registration', () => {
  test('unchanged capabilities are omitted; a content change is registered', async () => {
    const f = fixture()
    await f.beat()
    await f.beat()
    expect(f.rows[0]).toHaveProperty('capabilities')
    expect(f.rows[1]).not.toHaveProperty('capabilities')
    f.setActions(['changed'])
    await f.beat()
    expect(f.rows[2].capabilities).toMatchObject({ runtimes: ['changed'] })
  })

  test.each([null, { capabilities: {} }])('repairs an externally missing or cleared registration: %j', async (row) => {
    const f = fixture()
    await f.beat()
    f.replace(row)
    await f.beat()
    expect(f.rows).toHaveLength(3)
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
