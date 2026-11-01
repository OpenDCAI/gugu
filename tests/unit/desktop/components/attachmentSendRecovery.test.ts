import { afterEach, expect, it, vi } from 'vitest'
import { attachmentAttemptEndpoint, retryAttachmentUpload } from '../../../../apps/desktop/src/lib/attachmentSendRecovery'
import { AttachmentsError } from '@gugu/core/cloud/attachmentsApi'
afterEach(() => { vi.useRealTimers() })
it('retries upload transport loss but not a permanent authorization error', async () => {
  vi.useFakeTimers()
  const run = vi.fn().mockRejectedValueOnce(new TypeError('storage response lost')).mockResolvedValue('same staged bytes')
  const done = retryAttachmentUpload(run)
  await vi.advanceTimersByTimeAsync(500)
  expect(await done).toBe('same staged bytes')
  expect(run.mock.calls).toEqual([[1], [2]])
  const denied = vi.fn().mockRejectedValue(new AttachmentsError('upload', 403, 'denied', 'Not allowed'))
  await expect(retryAttachmentUpload(denied)).rejects.toThrow('Not allowed')
  expect(denied).toHaveBeenCalledOnce()
})
it('keeps cancellation attached to both planning and byte upload attempts', async () => {
  const controller = new AbortController()
  const fetcher = vi.fn(async (_url: unknown, _init: unknown) => new Response())
  const uploader = vi.fn(async (_url: unknown, _init: unknown, _progress: unknown) => ({ status: 200 }))
  const endpoint = attachmentAttemptEndpoint({ supabaseUrl: 'https://db.test', anonKey: 'anon', token: 'token', fetch: fetcher, upload: uploader }, controller.signal)
  await endpoint.fetch!('https://db.test', {})
  await endpoint.upload!('https://oss.test', { method: 'PUT', body: new Blob() }, () => {})
  controller.abort()
  expect((fetcher.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true)
  expect((uploader.mock.calls[0][1] as { signal: AbortSignal }).signal.aborted).toBe(true)
})
