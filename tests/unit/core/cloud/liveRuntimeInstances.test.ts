import { describe, expect, it } from 'vitest'
import { readLiveDeviceRuntimeInstanceIds, RUNTIME_INSTANCE_STALE_MS, type DeviceCommandTableClient } from '@gugu/core/cloud/deviceCommands'

const NOW = Date.parse('2026-11-06T12:00:00.000Z')

describe('readLiveDeviceRuntimeInstanceIds', () => {
  it('asks the server for this device\'s live instances only and returns their ids', async () => {
    const calls: unknown[][] = []
    const selector = {
      eq(...args: unknown[]) { calls.push(['eq', ...args]); return selector },
      gt(...args: unknown[]) { calls.push(['gt', ...args]); return selector },
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [{ instance_id: 'a' }, { instance_id: 'b' }], error: null }).then(resolve),
    }
    const client = {
      from: (table: string) => { calls.push(['from', table]); return { select: (columns: string) => { calls.push(['select', columns]); return selector } } },
    } as unknown as DeviceCommandTableClient
    expect(await readLiveDeviceRuntimeInstanceIds(client, 'dev-1', NOW)).toEqual(new Set(['a', 'b']))
    expect(calls).toEqual([
      ['from', 'runtime_instances'],
      ['select', 'instance_id'],
      ['eq', 'device_id', 'dev-1'],
      ['gt', 'last_heartbeat_at', new Date(NOW - RUNTIME_INSTANCE_STALE_MS).toISOString()],
    ])
  })
})
