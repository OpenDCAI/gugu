// #791: the host drains next versions handed to it — woken on its device channel and on every reconnect.
import { describe, expect, test, vi } from 'vitest'
import type { PendingHandoff } from '@gugu/core/cloud/fileVersionHandoff'

const opened = vi.hoisted(() => ({ fail: new Set<string>() }))
vi.mock('@gugu/core/cloud/fileVersionHandoff', () => ({
  openHandoff: vi.fn(async (_endpoint: unknown, row: PendingHandoff) => {
    if (opened.fail.has(row.id)) throw new Error('File authentication failed')
    return new TextEncoder().encode(`bytes of ${row.id}`)
  }),
}))
const { createVersionHandoffHost } = await import('../../../../apps/desktop/electron/projectFileVersionHandoffHost')

const row = (id: string, device = 'mac'): PendingHandoff => ({ id, item_id: 'item', base_version: 1, chat_id: 'chat', host_device_id: device, requester_actor: 'agent-b',
  file_name: 'notes.md', content_type: 'text/markdown', size_bytes: 10, sha256: 'ab'.repeat(32), ciphertext_bytes: 59, ciphertext_sha256: 'cd'.repeat(32) })
function host(rows: PendingHandoff[]) {
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    expect(JSON.parse(String(init?.body))).toEqual({ device_id: 'mac' })
    return new Response(JSON.stringify({ handoffs: rows }))
  })
  const publish = vi.fn(async () => ({})) as unknown as Parameters<typeof createVersionHandoffHost>[0]['publish'] & ReturnType<typeof vi.fn>
  const drain = createVersionHandoffHost({ identity: async () => ({ accountId: 'owner', deviceId: 'mac' }),
    endpoint: async () => ({ supabaseUrl: 'https://db.test', anonKey: 'anon', token: 'token', fetch: fetch as unknown as typeof globalThis.fetch }), publish })
  return { drain, publish, fetch }
}

describe('next versions handed to this host', () => {
  test('each is written once, as the host, through the publisher with its handoff id', async () => {
    const h = host([row('h1'), row('h2')])
    await h.drain()
    expect(h.publish.mock.calls.map(call => [call[0], (call[1] as { name: string }).name, Buffer.from((call[1] as { bytes: ArrayBuffer }).bytes).toString(), call[3], call[5]])).toEqual([
      ['chat', 'notes.md', 'bytes of h1', 'owner', { handoff: 'h1' }],
      ['chat', 'notes.md', 'bytes of h2', 'owner', { handoff: 'h2' }],
    ])
    await h.drain()
    expect(h.publish).toHaveBeenCalledTimes(2)
  })
  test('one that fails does not stop the rest, is reported, and is not retried in a loop', async () => {
    opened.fail.add('bad')
    const h = host([row('bad'), row('good')])
    await expect(h.drain()).rejects.toThrow('1 next version handoff(s) were not written')
    expect(h.publish).toHaveBeenCalledOnce()
    await h.drain()
    expect(h.publish).toHaveBeenCalledOnce()
  })
  test('a row for another device is left alone', async () => {
    const h = host([row('other', 'pc')])
    await h.drain()
    expect(h.publish).not.toHaveBeenCalled()
  })
  test('a new file with no base revision uses the same publisher and is drained once', async () => {
    const h = host([{ ...row('new'), base_version: null }])
    await h.drain(); await h.drain()
    expect(h.publish).toHaveBeenCalledOnce()
    expect(h.publish.mock.calls[0]).toMatchObject({ 0: 'chat', 3: 'owner', 5: { handoff: 'new' } })
  })
})
