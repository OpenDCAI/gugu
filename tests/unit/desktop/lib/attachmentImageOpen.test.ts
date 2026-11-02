// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { attachmentQueryClient } from '@/lib/attachmentQueryClient'
import { openAttachmentImage } from '@/lib/attachmentBytes'
import { registerImageViewerHost, type ImageViewerRequest } from '@/lib/imageViewer'

const io = vi.hoisted(() => ({ resolve: vi.fn(), original: vi.fn(), put: vi.fn(), url: vi.fn(), revoke: vi.fn() }))
vi.mock('@/lib/fileAccess', () => ({
  resolveFile: io.resolve, fileReader: () => ({ accountId: 'account', actorId: 'account' }), fileReadSignal: () => undefined,
  attachmentCache: async () => ({ put: io.put }), attachmentCacheOrigin: 'https://attachments.test',
}))
vi.mock('@gugu/core/shared/fileResolver', async original => ({ ...await original<typeof import('@gugu/core/shared/fileResolver')>(), fileBlob: io.original }))

const source = { kind: 'item' as const, itemId: 'file', version: 2 }
const revision = { source: 'managed-object', item_id: 'file', version: 2, file_name: 'photo.png', content_type: 'image/png', size_bytes: 8, sha256: '0'.repeat(64) }
let request: ImageViewerRequest
let unregister: () => void
beforeEach(() => {
  attachmentQueryClient.clear()
  vi.clearAllMocks()
  io.url.mockImplementation((blob: Blob) => blob.size === 5 ? 'blob:thumb' : 'blob:full')
  vi.stubGlobal('URL', class extends URL { static createObjectURL = io.url; static revokeObjectURL = io.revoke })
  unregister = registerImageViewerHost(value => { request = value })
  io.resolve.mockImplementation(async (_ref, _reader, options) => options?.purpose === 'preview'
    ? { status: 'ready', revision, content: async () => new Blob(['thumb']), dispose: vi.fn() }
    : { status: 'ready', revision, reader: { accountId: 'account' } })
  io.original.mockResolvedValue(new Blob(['original']))
})
afterEach(() => { request?.items[0].release?.(); unregister(); attachmentQueryClient.clear(); vi.unstubAllGlobals() })

it('opens synchronously without a read, then shares thumbnail and verified lazy-original capabilities', async () => {
  openAttachmentImage(source, 'photo.png', { chatId: 'chat', messageId: 'message' })
  expect(io.resolve).not.toHaveBeenCalled()
  const item = request.items[0]
  expect(item).toMatchObject({ url: '', file: { name: 'photo.png' }, source: { chatId: 'chat', messageId: 'message' }, resource: { kind: 'file', target: { kind: 'file', itemId: 'file', version: 2 } } })
  await expect(item.preview?.()).resolves.toBe('blob:thumb')
  expect(io.original).not.toHaveBeenCalled()
  const first = item.full!()
  expect(item.full!()).toBe(first)
  await expect(first).resolves.toBe('blob:full')
  expect(io.original).toHaveBeenCalledTimes(1)
  item.release?.()
  expect(io.revoke.mock.calls).toEqual([['blob:thumb'], ['blob:full']])
})

it('releases a thumbnail that arrives after closing without fetching the original or opening again', async () => {
  let finish!: (value: Blob) => void
  const content = new Promise<Blob>(resolve => { finish = resolve })
  io.resolve.mockResolvedValue({ status: 'ready', revision, content: () => content, dispose: vi.fn() })
  openAttachmentImage(source, 'photo.png')
  const item = request.items[0], thumbnail = item.preview!()
  item.release?.()
  finish(new Blob(['thumb']))
  await expect(thumbnail).resolves.toBe('blob:thumb')
  expect(io.revoke).toHaveBeenCalledWith('blob:thumb')
  expect(io.original).not.toHaveBeenCalled()
})
