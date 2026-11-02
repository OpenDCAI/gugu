import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), path: vi.fn(), prefetch: vi.fn(), push: vi.fn(), upload: vi.fn(), place: vi.fn() }))
vi.mock('@/lib/sessionPublication', () => ({ getRendererAccessToken: () => 'test-token' }))
vi.mock('@renderer/lib/pty/terminal-image-paths', () => ({ mustCopyRatherThanReference: () => false, isHeicLikeFile: (file: File) => file.type === 'image/heic' }))
vi.mock('@/lib/taskAttachmentTarget', () => ({ prefetchTaskFiles: mocks.prefetch, pushTaskFiles: mocks.push, taskAttachmentUsesSsh: () => false }))
vi.mock('@gugu/core/cloud/attachmentsApi', async original => ({ ...await original<object>(), configuredEndpoint: () => ({ supabaseUrl: 'https://files.invalid', anonKey: 'public', token: 'test' }), uploadAttachmentBytes: mocks.upload, placeAttachment: mocks.place }))

import { placeTaskAttachment, prepareTaskAttachment, type TaskAttachmentPlacement } from '../../../../apps/desktop/src/lib/attachmentsEndpoint'

const file = new File(['abc'], 'brief.txt', { type: 'text/plain' })
const ref = { itemId: 'file', version: 1, name: file.name, mimeType: file.type, sizeBytes: file.size, path: '/original/brief.txt' }
const destination = { chatId: 'chat', owner: 'owner', deviceId: 'host', sessionId: 'session' }
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('window', { electronAPI: { invoke: mocks.invoke, getPathForFile: mocks.path } })
  mocks.invoke.mockResolvedValue({ id: ref.itemId, version: ref.version })
  mocks.prefetch.mockResolvedValue(undefined)
})
afterEach(() => vi.unstubAllGlobals())

it('retries destination prefetch without publishing the already-published item again', async () => {
  const placement: TaskAttachmentPlacement = {}
  mocks.prefetch.mockRejectedValueOnce(Object.assign(new Error('transfer disabled'), { code: 'transfer_disabled' }))
  await expect(placeTaskAttachment(file, ref, destination, undefined, { placement })).rejects.toThrow('transfer disabled')
  await expect(placeTaskAttachment(file, ref, destination, undefined, { placement })).resolves.toEqual(ref)
  expect(mocks.invoke).toHaveBeenCalledTimes(1)
  expect(mocks.prefetch).toHaveBeenCalledTimes(2)
})

it('cancels the actual OSS fetch and never places its result in the folder', async () => {
  const controller = new AbortController()
  const { uploadAttachmentBytes } = await vi.importActual<typeof import('@gugu/core/cloud/attachmentsApi')>('@gugu/core/cloud/attachmentsApi')
  let started!: () => void
  const uploading = new Promise<void>(resolve => { started = resolve })
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith('/upload')) return new Response(JSON.stringify({ staging_key: 'stage', url: 'https://oss.invalid/put', fields: {}, max_bytes: 1024 }))
    started()
    return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }))
  })
  mocks.upload.mockImplementation((endpoint, bytes, scope, options) => uploadAttachmentBytes({ ...endpoint, fetch }, bytes, scope, options))
  const result = placeTaskAttachment(file, null, destination, undefined, { signal: controller.signal })
  const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' })
  await uploading
  controller.abort()
  await rejected
  expect(mocks.place).not.toHaveBeenCalled()
  expect(mocks.prefetch).not.toHaveBeenCalled()
})

it('uses the converted copy filename and mime type before publishing or SSH placement', async () => {
  mocks.path.mockReturnValue('/original/photo.heic')
  mocks.invoke.mockResolvedValue({ path: '/prepared/photo.png', name: 'photo.png', mimeType: 'image/png', size: 5 })
  expect(await prepareTaskAttachment(new File(['heic'], 'photo.heic', { type: 'image/heic' }))).toMatchObject({ name: 'photo.png', mimeType: 'image/png', path: '/prepared/photo.png', sizeBytes: 5 })
})
