import { describe, expect, it, vi } from 'vitest'
import { createFileResolver, type FileMetadata, type FileRevision } from '@gugu/core/shared/fileResolver'
const actor = { accountId: 'owner', actorId: 'owner' }
const revision: FileRevision = { source: 'managed-object', item_id: 'file', version: 1, file_name: 'file.bin', content_type: 'application/octet-stream', size_bytes: 1, sha256: 'ab'.repeat(32) }
function fixture() {
  let status: 'ready' | 'expired' | 'gone' = 'expired'
  const bytes = vi.fn(async () => { throw Error('Display touched signer/bytes') })
  const metadata = vi.fn(async (): Promise<FileMetadata> => status === 'ready' ? { status, revision } : { status, sha256: revision.sha256 })
  return { set: (value: typeof status) => { status = value }, bytes, metadata, resolve: createFileResolver({ local: async () => null, metadata, managed: bytes, temporary: bytes, ssh: bytes }) }
}
describe('expired attachment metadata', () => {
  it('distinguishes expiry from deletion and permits a re-upload to become readable', async () => {
    const f = fixture(), ref = { item_id: 'file', version: 1 }
    expect(await f.resolve(ref, actor)).toEqual({ status: 'expired', sha256: revision.sha256 })
    f.set('ready'); expect(await f.resolve(ref, actor)).toMatchObject({ status: 'ready', purpose: 'file' })
    f.set('gone'); expect(await f.resolve(ref, actor)).toEqual({ status: 'gone', sha256: revision.sha256 })
  })
  it('keeps private-message expiry distinct and never exposes a stale URL from metadata', async () => {
    const f = fixture()
    f.metadata.mockResolvedValue({ status: 'expired', sha256: null, url: 'https://example.test/stale' } as FileMetadata)
    const answer = await f.resolve({ message_id: 'private' }, actor)
    expect(answer).toMatchObject({ status: 'expired' }); expect('read' in answer).toBe(false)
    expect(f.bytes).not.toHaveBeenCalled()
  })
  it('displaying ready or expired metadata performs no signing, reservation or byte read', async () => {
    const f = fixture(), ref = { item_id: 'file', version: 1 }
    for (const status of ['ready', 'expired'] as const) { f.set(status); expect(await f.resolve(ref, actor)).toMatchObject({ status }) }
    expect(f.metadata.mock.calls).toHaveLength(2); expect(f.bytes).not.toHaveBeenCalled()
    f.metadata.mockRejectedValue(Error('metadata is unavailable'))
    await expect(f.resolve(ref, actor)).rejects.toThrow('metadata is unavailable'); expect(f.bytes).not.toHaveBeenCalled()
  })
})
