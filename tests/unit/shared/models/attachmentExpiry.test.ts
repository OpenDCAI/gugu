import { describe, expect, it } from 'vitest'
import { createAttachmentResolver } from '@gugu/core/shared/attachmentUrls'

describe('expired attachment metadata', () => {
  it('distinguishes expiry without a URL from deletion and permits re-upload to become readable', async () => {
    let expired = true
    const resolver = createAttachmentResolver(async () => ({ urls: [expired
      ? { item_id: 'file', version: 1, status: 'expired' }
      : { item_id: 'file', version: 1, url: 'https://example.test/file', expires_at: '2999-01-01T00:00:00Z' },
    ] }))
    const source = { kind: 'item' as const, itemId: 'file', version: 1 }
    expect(await resolver.resolve(source)).toEqual({ status: 'expired' })
    expired = false
    expect(await resolver.resolve(source)).toMatchObject({ status: 'ready', url: 'https://example.test/file' })
    expect(await resolver.resolve({ kind: 'item', itemId: 'deleted', version: 1 })).toEqual({ status: 'gone' })
  })

  it('keeps a message expiry distinct and never treats an expired row with a stray URL as downloadable', async () => {
    const resolver = createAttachmentResolver(async () => ({ urls: [{ message_id: 'private', status: 'expired', url: 'https://example.test/stale' }] }))
    expect(await resolver.resolve({ kind: 'message', messageId: 'private' })).toEqual({ status: 'expired' })
  })

  it('displaying ready or expired metadata never falls back to URL signing', async () => {
    let signed = 0
    const refs: unknown[] = []
    let status = 'ready'
    const resolver = createAttachmentResolver(async () => { signed += 1; return { urls: [] } }, {
      fetchMetadata: async (ref) => { refs.push(ref); return { status, sha256: 'ab'.repeat(32) } },
    })
    const source = { kind: 'item' as const, itemId: 'file', version: 1 }
    expect(await resolver.metadata(source)).toEqual({ status: 'ready', sha256: 'ab'.repeat(32) })
    status = 'expired'
    expect(await resolver.metadata(source)).toMatchObject({ status: 'expired' })
    expect(refs).toEqual([{ item_id: 'file', version: 1 }, { item_id: 'file', version: 1 }])
    expect(signed).toBe(0)
    await expect(createAttachmentResolver(async () => { signed += 1; return { urls: [] } }).metadata(source)).rejects.toThrow('metadata is unavailable')
    expect(signed).toBe(0)
  })
})
