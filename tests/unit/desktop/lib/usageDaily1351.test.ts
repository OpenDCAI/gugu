import { createClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { replaceUsageDeviceRows } from '@gugu/core/cloud/usageDaily'
import { snapshotToRows, type UsageDailyRow } from '@gugu/core/shared/usage/rows'

function storage() {
  const rows: UsageDailyRow[] = []
  const calls: Array<{ method: string; device: string | null }> = []
  let fail = false
  const client = createClient('http://usage.test', 'test-anon', { global: { fetch: async (input, init) => {
    const url = new URL(String(input)); const method = init?.method ?? 'GET'
    const device = url.searchParams.get('device_id')?.replace(/^eq\./, '') ?? null
    calls.push({ method, device })
    if (fail) return new Response(JSON.stringify({ message: 'cloud unavailable' }), { status: 500, headers: { 'Content-Type': 'application/json' } })
    if (method === 'POST') {
      const incoming = JSON.parse(String(init?.body)) as UsageDailyRow[]
      for (const row of incoming) {
        const index = rows.findIndex(r => r.device_id === row.device_id && r.day === row.day && r.engine === row.engine)
        if (index < 0) rows.push(row); else rows[index] = row
      }
      return new Response(null, { status: 201 })
    }
    const selected = rows.filter(row => row.device_id === device)
    if (method === 'DELETE') {
      const day = url.searchParams.get('day')?.slice(3), engine = url.searchParams.get('engine')?.slice(3)
      const i = rows.findIndex(row => row.device_id === device && row.day === day && row.engine === engine)
      if (i >= 0) rows.splice(i, 1)
      return new Response(null, { status: 204 })
    }
    return new Response(JSON.stringify(selected.map(({ day, engine }) => ({ day, engine }))), { headers: { 'Content-Type': 'application/json' } })
  } } })
  return { client, rows, calls, reject: () => { fail = true } }
}
const rowsFor = (deviceId: string) => snapshotToRows({ from: '2026-11-02', to: '2026-11-02', engines: [], device: [{ day: '2026-11-02', parallelSeconds: 10, peakConcurrency: 2 }] }, 'owner', deviceId)

describe('desktop/server shared usage writer', () => {
  it('replacing a desktop range cannot delete independent server rows', async () => {
    const cloud = storage()
    await replaceUsageDeviceRows(cloud.client, rowsFor('desktop-hardware'), 'desktop-hardware', '2026-11-02', '2026-11-02')
    await replaceUsageDeviceRows(cloud.client, rowsFor('server-install'), 'server-install', '2026-11-02', '2026-11-02')
    await replaceUsageDeviceRows(cloud.client, [], 'desktop-hardware', '2026-11-02', '2026-11-02')
    expect(cloud.rows.map(r => r.device_id)).toEqual(['server-install'])
    expect(cloud.calls.filter(c => c.method === 'DELETE')).toEqual([{ method: 'DELETE', device: 'desktop-hardware' }])
  })
  it('cloud write failures reject instead of recording an empty successful sync', async () => {
    const cloud = storage(); cloud.reject()
    await expect(replaceUsageDeviceRows(cloud.client, rowsFor('server-install'), 'server-install', '2026-11-02', '2026-11-02')).rejects.toThrow('cloud unavailable')
    expect(cloud.calls.map(c => c.method)).toEqual(['POST'])
  })
})
