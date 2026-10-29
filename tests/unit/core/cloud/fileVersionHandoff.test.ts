// #791: a member's changed copy of a project file kept on another machine, handed to that machine: the requester
// encrypts and uploads it, the host decrypts what was committed; neither the key nor the plaintext passes the store.
import { createHash } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { handOffNextVersion, openHandoff, type PendingHandoff } from '@gugu/core/cloud/fileVersionHandoff'

const ITEM = '00000000-0000-4000-8000-0000000000aa'
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const copy = new TextEncoder().encode('# Notes\nfixed the typo\n')

/** A fake attachments function and object store, enough of the server to run both sides against. */
function server(answers: { request?: Record<string, unknown>; statuses?: string[] } = {}) {
  const calls: Array<[string, Record<string, unknown>]> = []
  let stored: Uint8Array | null = null, committed: Record<string, unknown> | null = null
  const statuses = [...(answers.statuses ?? ['published'])]
  const fetch = (async (url: string, init?: RequestInit) => {
    if (url === 'https://store.test/put') { stored = new Uint8Array(await new Response(init?.body as BodyInit).arrayBuffer()); return new Response(null, { status: 200 }) }
    if (url === 'https://store.test/get') return new Response(stored as BodyInit)
    const route = url.split('/').at(-1)!, body = JSON.parse(String(init?.body)) as Record<string, unknown>
    calls.push([route, body])
    const json = (value: unknown) => new Response(JSON.stringify(value))
    if (route === 'file-handoff-request') return json(answers.request ?? { status: 'uploading', handoff_id: body.handoff_id,
      upload: { url: 'https://store.test/put', method: 'PUT', fields: {}, max_bytes: body.ciphertext_bytes } })
    if (route === 'file-handoff-commit') { committed = body; return json({ status: 'ready' }) }
    if (route === 'file-handoff-status') return json(body.cancel ? { status: 'cancelled', host_label: 'Studio Mac' } : { status: statuses.shift() ?? 'ready', version: 3, message_id: 'm3' })
    if (route === 'file-handoff-download') return json({ url: 'https://store.test/get', key: committed!.key, codec: 'secretstream-v1',
      ciphertext_bytes: committed!.ciphertext_bytes, ciphertext_sha256: committed!.ciphertext_sha256 })
    return new Response('{}', { status: 404 })
  }) as typeof globalThis.fetch
  return { endpoint: { supabaseUrl: 'https://db.test', anonKey: 'anon', token: 'token', fetch }, calls, stored: () => stored, committed: () => committed }
}
const request = { itemId: ITEM, expectedVersion: 2, fileName: 'notes.md', contentType: 'text/markdown', bytes: copy, as: 'agent-b', message: { message_id: 'm3' } }
const pending = (s: ReturnType<typeof server>): PendingHandoff => {
  const asked = s.calls.find(([route]) => route === 'file-handoff-request')![1]
  return { id: String(asked.handoff_id), item_id: ITEM, base_version: 2, chat_id: 'chat', host_device_id: 'mac', requester_actor: 'agent-b', file_name: 'notes.md',
    content_type: 'text/markdown', size_bytes: copy.byteLength, sha256: sha(copy), ciphertext_bytes: Number(asked.ciphertext_bytes), ciphertext_sha256: String(s.committed()!.ciphertext_sha256) }
}

describe('handing a next version to the machine that keeps the file', () => {
  test('the store sees only ciphertext; the host gets the exact copy back', async () => {
    const s = server()
    expect(await handOffNextVersion(s.endpoint, request)).toMatchObject({ status: 'published', version: 3, message_id: 'm3' })
    const asked = s.calls[0]![1]
    expect(asked).toMatchObject({ item_id: ITEM, expected_version: 2, size_bytes: copy.byteLength, sha256: sha(copy), as: 'agent-b', message: { message_id: 'm3' } })
    expect(s.stored()!.byteLength).toBe(asked.ciphertext_bytes)
    expect(Buffer.from(s.stored()!).includes(Buffer.from('fixed the typo'))).toBe(false)
    expect(s.committed()!.ciphertext_sha256).toBe(sha(s.stored()!))
    expect(Buffer.from(await openHandoff(s.endpoint, pending(s))).toString()).toBe('# Notes\nfixed the typo\n')
  })
  test('the ciphertext is bound to the version it is meant to become: opened as another version it fails', async () => {
    const s = server()
    await handOffNextVersion(s.endpoint, request)
    await expect(openHandoff(s.endpoint, { ...pending(s), base_version: 3 })).rejects.toThrow(/authentication failed/)
    // The committed plaintext digest is bound the same way.
    await expect(openHandoff(s.endpoint, { ...pending(s), sha256: 'ab'.repeat(32) })).rejects.toThrow(/authentication failed/)
  })
  test('refused at once (host offline) or of an older version: nothing is uploaded', async () => {
    for (const answer of [{ status: 'host_offline', host_label: 'Studio Mac' }, { status: 'conflict', current_version: 4 }]) {
      const s = server({ request: answer })
      expect(await handOffNextVersion(s.endpoint, request)).toEqual(answer)
      expect(s.stored()).toBeNull()
      expect(s.calls.map(([route]) => route)).toEqual(['file-handoff-request'])
    }
  })
  test('the host did not write it in time: the handoff is withdrawn, and that is the answer', async () => {
    const s = server({ statuses: ['ready', 'ready', 'ready'] })
    let clock = 0
    const outcome = await handOffNextVersion(s.endpoint, request, { waitMs: 2000, pollMs: 700, now: () => clock, sleep: async ms => { clock += ms } })
    expect(outcome).toMatchObject({ status: 'timeout', host_label: 'Studio Mac' })
    const statuses = s.calls.filter(([route]) => route === 'file-handoff-status').map(([, body]) => body.cancel === true)
    expect(statuses).toEqual([false, false, false, true])
  })
})
