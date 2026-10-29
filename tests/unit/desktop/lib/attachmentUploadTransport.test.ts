// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { xhrAttachmentUpload } from '../../../../apps/desktop/src/lib/attachmentUploadTransport'
import { attachmentSendTiming, AttachmentStageTimeout } from '../../../../apps/desktop/src/lib/attachmentSendTiming'

vi.mock('../../../../apps/desktop/src/lib/log', () => ({ rendererLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }))

class Upload {
  static requests: Upload[] = []
  upload = { onprogress: null as ((event: ProgressEvent) => void) | null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  status = 204
  opened = false
  aborted = false
  body: unknown
  headers: Record<string, string> = {}
  constructor() { Upload.requests.push(this) }
  open() { this.opened = true }
  setRequestHeader(key: string, value: string) { this.headers[key] = value }
  send(body: unknown) { this.body = body }
  abort() { this.aborted = true; this.onabort?.() }
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); Upload.requests = [] })

describe('observable browser attachment transport (#1002)', () => {
  it('reports only real upload events and forwards the signed body and headers', async () => {
    vi.stubGlobal('XMLHttpRequest', Upload)
    const body = new Blob(['file']), progress = vi.fn()
    const done = xhrAttachmentUpload('https://storage.test/scoped', {
      method: 'PUT', body, headers: { 'content-type': 'image/png', 'x-upsert': 'false' },
    }, progress)
    const request = Upload.requests[0]
    expect(progress).not.toHaveBeenCalled()
    request.upload.onprogress?.(new ProgressEvent('progress', { loaded: 2, total: 4, lengthComputable: true }))
    expect(progress).toHaveBeenCalledExactlyOnceWith({ loaded: 2, total: 4 })
    expect(request.body).toBe(body)
    expect(request.headers).toEqual({ 'content-type': 'image/png', 'x-upsert': 'false' })
    request.onload?.()
    await expect(done).resolves.toEqual({ status: 204 })
    expect(request.upload.onprogress).toBeNull()
  })

  it('aborts the actual request when it never advances, then rejects the attempt', async () => {
    vi.useFakeTimers(); vi.stubGlobal('XMLHttpRequest', Upload)
    const done = attachmentSendTiming('m', 'c').stage('upload', 1, signal => xhrAttachmentUpload('https://storage.test/scoped', {
      method: 'POST', body: new FormData(), signal,
    })).catch(error => error)
    await vi.advanceTimersByTimeAsync(15_001)
    expect(await done).toBeInstanceOf(AttachmentStageTimeout)
    expect(Upload.requests[0].aborted).toBe(true)
    expect(Upload.requests[0].upload.onprogress).toBeNull()
  })

  it('does not open a request whose attempt was already cancelled', async () => {
    vi.stubGlobal('XMLHttpRequest', Upload)
    const controller = new AbortController(), reason = new Error('cancelled attempt')
    controller.abort(reason)
    await expect(xhrAttachmentUpload('https://storage.test/scoped', {
      method: 'PUT', body: new Blob(), signal: controller.signal,
    })).rejects.toBe(reason)
    expect(Upload.requests[0].opened).toBe(false)
  })
})
