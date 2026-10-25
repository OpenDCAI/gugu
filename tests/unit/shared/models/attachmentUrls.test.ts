import { describe, expect, it, vi } from 'vitest'
import { createFileMetadataLoader, FILE_METADATA_BATCH_MAX } from '@gugu/core/cloud/fileMetadata'
import { cloudFileProviders } from '@gugu/core/cloud/fileProviders'
import { createFileResolver, type FileRef, type FileRevision } from '@gugu/core/shared/fileResolver'
import { attachmentFileRef, parseAttachmentContent } from '@gugu/core/shared/ui/attachmentModels'

const actor = { accountId: 'owner', actorId: 'owner' }
const revision: FileRevision = { source: 'managed-object', file_name: 'image.png', content_type: 'image/png', size_bytes: 16, sha256: 'ab'.repeat(32), width: 800, height: 600 }
function fixture() {
  const calls: FileRef[][] = [], hidden = new Set<string>()
  let failing = false, malformed = false
  const metadata = createFileMetadataLoader(async (_context, refs) => {
    calls.push(refs)
    if (failing) throw Error('file-resolve 503')
    if (malformed) return { error: 'not_configured' }
    return { files: refs.map(ref => ({ ref, ...(hidden.has('item_id' in ref ? ref.item_id : 'message_id' in ref ? ref.message_id : ref.attachment_id) ? { status: 'gone', sha256: null } : { status: 'ready', ...revision }) })) }
  })
  const bytes = vi.fn(async () => { throw Error('Metadata must not sign or read') })
  const cloud = cloudFileProviders({ metadata, endpoint: bytes, sink: bytes, cache: { get: async () => null, put: bytes, clear: bytes } })
  const resolve = createFileResolver({ ...cloud, local: async () => null, managed: bytes, ssh: bytes, temporary: bytes })
  return { calls, hidden, bytes, resolve: (ref: FileRef) => resolve(ref, actor), fail: (value: boolean) => { failing = value }, malformed: () => { malformed = true } }
}
const item = (item_id: string, version = 1) => ({ item_id, version })

describe('the former URL resolver protections now belong to the canonical metadata and file capabilities', () => {
  it('coalesces the visible batch and duplicate refs, maps dimensions/SHA exactly, and never fetches a body URL', async () => {
    const f = fixture(); f.hidden.add('deleted')
    const [a, a2, b, d] = await Promise.all([f.resolve(item('a')), f.resolve(item('a')), f.resolve(item('b', 2)), f.resolve(item('deleted'))])
    expect(f.calls).toEqual([[item('a'), item('b', 2), item('deleted')]])
    for (const file of [a, a2, b]) {
      expect(file).toMatchObject({ status: 'ready', purpose: 'file', revision: { sha256: 'ab'.repeat(32), width: 800, height: 600 } })
      expect('url' in file).toBe(false)
    }
    expect(d).toEqual({ status: 'gone', sha256: null }); expect(f.bytes).not.toHaveBeenCalled()
    const body = '[附件] image.png (image/png)\n[URL] http://127.0.0.1/private\n[Size] 16\n[Kind] image'
    expect(attachmentFileRef(parseAttachmentContent(body, { id: 'legacy-message' })!.source)).toEqual({ message_id: 'legacy-message' })
    expect(attachmentFileRef(parseAttachmentContent(body)!.source)).toBeNull()
    expect(attachmentFileRef({ kind: 'gone' })).toBeNull()
  })
  it('private message bytes still use the exact message authority and invisible references stay gone', async () => {
    const f = fixture(); f.hidden.add('m2')
    const [mine, theirs] = await Promise.all([f.resolve({ message_id: 'm1' }), f.resolve({ message_id: 'm2' })])
    expect(f.calls).toEqual([[{ message_id: 'm1' }, { message_id: 'm2' }]])
    expect(mine).toMatchObject({ status: 'ready' }); expect(theirs).toEqual({ status: 'gone', sha256: null })
    expect(f.bytes).not.toHaveBeenCalled()
  })
  it('bounds a large batch at 200 and never treats a cached URL as an access decision', async () => {
    const f = fixture()
    await Promise.all(Array.from({ length: FILE_METADATA_BATCH_MAX + 5 }, (_, i) => f.resolve(item(`m${i}`))))
    expect(f.calls.map(batch => batch.length)).toEqual([200, 5])
    f.hidden.add('m0')
    expect(await f.resolve(item('m0'))).toEqual({ status: 'gone', sha256: null })
    expect(f.calls.at(-1)).toEqual([item('m0')]); expect(f.bytes).not.toHaveBeenCalled()
  })
  it('a failed batch rejects every caller, retry recovers, and a changed ACL is checked without a second forget path', async () => {
    const f = fixture(); f.fail(true)
    const a = expect(f.resolve(item('a'))).rejects.toThrow('503'), b = expect(f.resolve(item('b'))).rejects.toThrow('503')
    await Promise.all([a, b]); f.fail(false)
    expect(await f.resolve(item('a'))).toMatchObject({ status: 'ready' }); expect(f.calls).toHaveLength(2)
    f.hidden.add('z'); expect(await f.resolve(item('z'))).toEqual({ status: 'gone', sha256: null })
    f.hidden.delete('z'); expect(await f.resolve(item('z'))).toMatchObject({ status: 'ready' })
  })
  it('malformed metadata is a failure for the complete batch, never a successful empty or tombstone answer', async () => {
    const f = fixture(); f.malformed()
    const a = expect(f.resolve(item('a'))).rejects.toThrow('Invalid file metadata batch'), b = expect(f.resolve(item('b'))).rejects.toThrow('Invalid file metadata batch')
    await Promise.all([a, b]); expect(f.bytes).not.toHaveBeenCalled()
  })
})
