import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { createFileResolver, FILE_CHUNK_BYTES, type FileBytes, type FileHandle, type FileProviders, type FileRevision, type ResolvedPreview } from '../../../../packages/core/src/shared/fileResolver'
import type { AppPlatform } from '../../../../apps/desktop/src/platform/types'
import type { DownloadSource } from '../../../../apps/desktop/src/session/shared/extensions/app-files-core'
import type { packageBytes } from '../../../../apps/desktop/src/session/shared/extensions/attachment-install'
import type { sendAttachmentBatch } from '../../../../apps/desktop/src/components/chat/sendAttachmentBatch'
import { fileBlob, stageFileHandle } from '../../../../packages/core/src/shared/fileResolver'
import { saveFileHandle } from '../../../../packages/core/src/local/files/fileSnapshots'

const actor = { accountId: 'owner', actorId: 'owner' }
const ref = { item_id: 'file', version: 1 }
const revision: FileRevision = { source: 'local', item_id: 'file', version: 1, chat_id: 'group', file_name: 'original.bin',
  content_type: 'application/octet-stream', size_bytes: 16, sha256: 'ab'.repeat(32), host_account_id: 'owner',
  host_device_id: 'device', host_project_id: 'project', relative_path: 'docs/original.bin', temporary_transfer: true }
function fixture() {
  const file: FileBytes = { size: 16, read: vi.fn(async (_offset: number, length: number) => new Uint8Array(length)), dispose: vi.fn(async () => {}) }
  const providers = {
    local: vi.fn<FileProviders['local']>().mockResolvedValue(null),
    metadata: vi.fn<FileProviders['metadata']>().mockResolvedValue({ status: 'ready', revision }),
    managed: vi.fn<FileProviders['managed']>().mockResolvedValue(file),
    ssh: vi.fn<FileProviders['ssh']>().mockResolvedValue(null),
    temporary: vi.fn<FileProviders['temporary']>().mockResolvedValue(file),
  }
  return { file, providers, resolve: createFileResolver(providers) }
}
describe('the canonical read-only file resolver', () => {
  it('a preview is a distinct, lazy display capability, never a full-file capability', async () => {
    type Preview = Extract<ResolvedPreview, { status: 'ready' }>
    expectTypeOf<Preview>().not.toExtend<FileHandle>()
    expectTypeOf<Preview>().not.toExtend<FileBytes>()
    expectTypeOf<Preview>().not.toExtend<Parameters<typeof saveFileHandle>[0]>()
    expectTypeOf<FileHandle>().not.toExtend<Preview>()
    const f = fixture(), image = new Blob(['thumbnail'], { type: 'image/webp' })
    const preview = vi.fn(async () => image)
    f.providers.metadata.mockResolvedValue({ status: 'ready', revision: { ...revision, source: 'managed-object' } })
    const result = await createFileResolver({ ...f.providers, preview })(ref, actor, { purpose: 'preview' })
    if (result.status !== 'ready') throw Error('Expected ready')
    expect(preview).not.toHaveBeenCalled(); expect('read' in result).toBe(false); expect('stream' in result).toBe(false)
    expect(await result.content()).toBe(image); expect(await result.content()).toBe(image)
    expect(preview).toHaveBeenCalledTimes(1)
    for (const call of [f.providers.managed, f.providers.ssh, f.providers.temporary]) expect(call).not.toHaveBeenCalled()
    await result.dispose(); expect(() => result.content()).toThrow('disposed')
  })
  it.each(['image/png', 'video/mp4'])('%s preview cannot enter any original-file consumer', async content_type => {
    type Preview = Extract<ResolvedPreview, { status: 'ready' }>
    expectTypeOf<Preview>().not.toExtend<Parameters<typeof saveFileHandle>[0]>()
    expectTypeOf<Preview>().not.toExtend<Parameters<AppPlatform['openRemoteFile']>[0]>()
    expectTypeOf<Preview>().not.toExtend<Parameters<typeof fileBlob>[0]>()
    expectTypeOf<Preview>().not.toExtend<Parameters<typeof stageFileHandle>[0]>()
    expectTypeOf<Preview>().not.toExtend<Parameters<typeof packageBytes>[0]>()
    expectTypeOf<Preview>().not.toExtend<Parameters<typeof sendAttachmentBatch>[0]['files'][number]>()
    expectTypeOf<Preview>().not.toExtend<Extract<DownloadSource, { kind: 'file' }>['file']>()
    const f = fixture(), preview = vi.fn(async () => new Blob(['preview']))
    f.providers.metadata.mockResolvedValue({ status: 'ready', revision: { ...revision, source: 'managed-object', content_type } })
    const result = await createFileResolver({ ...f.providers, preview })(ref, actor, { purpose: 'preview' })
    expect(result).toMatchObject({ purpose: 'preview' }); expect('reader' in result).toBe(false)
    expect('read' in result).toBe(false); expect('stream' in result).toBe(false)
    for (const provider of [f.providers.managed, f.providers.temporary, f.providers.ssh]) expect(provider).not.toHaveBeenCalled()
  })
  it.each([{}, { item_id: '' }, { item_id: 'file', version: -1 }, { item_id: 'file', message_id: 'message' }, { message_id: 'message', path: '/secret' }])('rejects malformed reference %j before consulting an index', async ref => {
    const f = fixture()
    await expect(f.resolve(ref as never, actor)).rejects.toThrow('Invalid file reference')
    expect(f.providers.local).not.toHaveBeenCalled(); expect(f.providers.metadata).not.toHaveBeenCalled()
  })
  it('the local-only metadata probe never consults the cloud, and uses the same lazy handle when found', async () => {
    const f = fixture()
    expect(await f.resolve(ref, actor, { localOnly: true })).toBeNull()
    expect(f.providers.metadata).not.toHaveBeenCalled()
    const open = vi.fn(async () => f.file)
    f.providers.local.mockResolvedValue({ revision, open })
    const file = await f.resolve(ref, actor, { localOnly: true })
    expect(file).toMatchObject({ status: 'ready', purpose: 'file', reader: actor })
    expect(open).not.toHaveBeenCalled(); expect(f.providers.metadata).not.toHaveBeenCalled()
    if (file?.status === 'ready') await file.dispose()
  })
  it('resolves an owned local index before any cloud metadata, signing or transport work', async () => {
    const f = fixture(), open = vi.fn(async () => f.file)
    f.providers.local.mockResolvedValue({ revision, open })
    const result = await f.resolve(ref, actor)
    expect(result.status).toBe('ready')
    for (const call of [f.providers.metadata, f.providers.managed, f.providers.ssh, f.providers.temporary, open]) expect(call).not.toHaveBeenCalled()
    if (result.status !== 'ready') throw Error('Expected ready')
    expect('url' in result).toBe(false)
    expect('write' in result).toBe(false)
    expect(await result.read(0, 4)).toEqual(new Uint8Array(4))
    expect(open).toHaveBeenCalledTimes(1)
    for (const call of [f.providers.metadata, f.providers.managed, f.providers.ssh, f.providers.temporary]) expect(call).not.toHaveBeenCalled()
    await result.dispose()
  })
  it.each(['gone', 'expired'] as const)('displays %s metadata without opening, signing or downloading', async status => {
    const f = fixture()
    f.providers.metadata.mockResolvedValue({ status, sha256: revision.sha256 })
    expect(await f.resolve(ref, actor)).toEqual({ status, sha256: revision.sha256 })
    for (const call of [f.providers.managed, f.providers.ssh, f.providers.temporary, f.file.read]) expect(call).not.toHaveBeenCalled()
  })
  it('ordinary cloud metadata is lazy; the first read selects the managed provider once', async () => {
    const f = fixture()
    f.providers.metadata.mockResolvedValue({ status: 'ready', revision: { ...revision, source: 'managed-object' } })
    const result = await f.resolve(ref, actor)
    expect(f.providers.managed).not.toHaveBeenCalled()
    if (result.status !== 'ready') throw Error('Expected ready')
    await Promise.all([result.read(0, 3), result.read(4, 2)])
    expect(f.providers.managed).toHaveBeenCalledTimes(1)
    expect(f.providers.ssh).not.toHaveBeenCalled(); expect(f.providers.temporary).not.toHaveBeenCalled()
    await result.dispose(); await result.dispose()
    expect(f.file.dispose).toHaveBeenCalledTimes(1)
  })
  it.each([
    [{ accountId: 'owner', actorId: 'owner' }, true],
    [{ accountId: 'other', actorId: 'other' }, false],
    [{ accountId: 'owner', actorId: 'owned-agent' }, false],
  ] as const)('borrows SSH only for the device owner acting as themselves (%j)', async (reader, own) => {
    const f = fixture()
    f.providers.ssh.mockResolvedValue(f.file)
    const result = await f.resolve(ref, reader)
    if (result.status !== 'ready') throw Error('Expected ready')
    await result.read(0, 1)
    expect(f.providers.ssh).toHaveBeenCalledTimes(own ? 1 : 0)
    expect(f.providers.temporary).toHaveBeenCalledTimes(own ? 0 : 1)
    await result.dispose()
  })
  it('an absent held SSH link may use allowed temporary transfer; an integrity refusal cannot', async () => {
    const f = fixture()
    const result = await f.resolve(ref, actor)
    if (result.status !== 'ready') throw Error('Expected ready')
    await result.read(0, 1)
    expect(f.providers.temporary).toHaveBeenCalledTimes(1)
    await result.dispose()
    f.providers.temporary.mockClear(); f.providers.ssh.mockRejectedValue(new Error('Snapshot SHA mismatch'))
    const refused = await f.resolve(ref, actor)
    if (refused.status !== 'ready') throw Error('Expected ready')
    await expect(refused.read(0, 1)).rejects.toThrow('SHA mismatch')
    expect(f.providers.temporary).not.toHaveBeenCalled()
  })
  it('strict no-upload refuses when local and existing SSH cannot supply the file', async () => {
    const f = fixture()
    f.providers.metadata.mockResolvedValue({ status: 'ready', revision: { ...revision, temporary_transfer: false } })
    const result = await f.resolve(ref, actor)
    if (result.status !== 'ready') throw Error('Expected ready')
    await expect(result.read(0, 1)).rejects.toThrow('Cloud transfer is disabled')
    expect(f.providers.temporary).not.toHaveBeenCalled()
  })
  it.each(['../secret', '/absolute', 'a/../secret', 'a//b', 'a\\b', 'a\u0000b'])('rejects unsafe local revision %j without a network fallback', async relative_path => {
    const f = fixture()
    f.providers.local.mockResolvedValue({ revision: { ...revision, relative_path }, open: async () => f.file })
    await expect(f.resolve(ref, actor)).rejects.toThrow('Invalid local file revision')
    for (const call of [f.providers.metadata, f.providers.ssh, f.providers.temporary]) expect(call).not.toHaveBeenCalled()
  })
  it('an index from another account cannot become a local read capability', async () => {
    const f = fixture()
    f.providers.local.mockResolvedValue({ revision, open: async () => f.file })
    await expect(f.resolve(ref, { accountId: 'other', actorId: 'other' })).rejects.toThrow('not owned')
    expect(f.providers.metadata).not.toHaveBeenCalled(); expect(f.file.read).not.toHaveBeenCalled()
  })
  it.each([[-1, 1], [0, -1], [17, 0], [16, 1], [0, FILE_CHUNK_BYTES + 1], [Number.MAX_SAFE_INTEGER + 1, 0]])('rejects range %j before opening a byte provider', async (offset, length) => {
    const f = fixture(), result = await f.resolve(ref, actor)
    if (result.status !== 'ready') throw Error('Expected ready')
    await expect(result.read(offset, length)).rejects.toThrow('Invalid file range')
    expect(f.providers.ssh).not.toHaveBeenCalled(); expect(f.providers.temporary).not.toHaveBeenCalled()
  })
  it('rejects changed snapshot size and cleans the private snapshot', async () => {
    const f = fixture()
    f.providers.ssh.mockResolvedValue({ ...f.file, size: 17 })
    const result = await f.resolve(ref, actor)
    if (result.status !== 'ready') throw Error('Expected ready')
    await expect(result.read(0, 1)).rejects.toThrow('snapshot size changed')
    expect(f.file.dispose).toHaveBeenCalledTimes(1)
    expect(f.providers.temporary).not.toHaveBeenCalled()
  })
  it('disposal during acquisition releases the returned snapshot without publishing bytes', async () => {
    const f = fixture()
    let finish!: (file: FileBytes) => void
    f.providers.ssh.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const result = await f.resolve(ref, actor)
    if (result.status !== 'ready') throw Error('Expected ready')
    const read = result.read(0, 1), checked = expect(read).rejects.toThrow('disposed')
    const closing = result.dispose()
    finish(f.file)
    await Promise.all([checked, closing])
    expect(f.file.dispose).toHaveBeenCalledTimes(1); expect(f.file.read).not.toHaveBeenCalled()
  })
  it('disposal cancels the in-flight verified provider instead of leaving its network request running', async () => {
    const f = fixture(); let aborted = false
    f.providers.metadata.mockResolvedValue({ status: 'ready', revision: { ...revision, source: 'managed-object' } })
    f.providers.managed.mockImplementation((_revision, context) => new Promise((_resolve, reject) => {
      context.signal!.addEventListener('abort', () => { aborted = true; reject(context.signal!.reason) }, { once: true })
    }))
    const result = await f.resolve(ref, actor)
    if (result.status !== 'ready') throw Error('Expected ready')
    const pending = expect(result.read(0, 1)).rejects.toThrow('disposed')
    await result.dispose(); await pending; expect(aborted).toBe(true)
  })
  it('an empty stream deliberately opens and authenticates, while mere display does not', async () => {
    const f = fixture()
    f.providers.metadata.mockResolvedValue({ status: 'ready', revision: { ...revision, size_bytes: 0, source: 'managed-object' } })
    f.providers.managed.mockResolvedValue({ ...f.file, size: 0 })
    const result = await f.resolve(ref, actor)
    if (result.status !== 'ready') throw Error('Expected ready')
    expect(f.providers.managed).not.toHaveBeenCalled()
    const chunks = []
    for await (const chunk of result.stream()) chunks.push(chunk)
    expect(chunks).toEqual([]); expect(f.providers.managed).toHaveBeenCalledTimes(1)
    await result.dispose()
  })
})
