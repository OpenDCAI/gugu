import { AttachmentsError, type AttachmentsEndpoint } from '@gugu/core/cloud/attachmentsApi'
import { AttachmentStageTimeout, linkedAttachmentSignal } from './attachmentSendTiming'
import { xhrAttachmentUpload } from './attachmentUploadTransport'

const MAX_ATTEMPTS = 3
export function retryableAttachmentError(error: unknown): boolean {
  return error instanceof AttachmentStageTimeout || error instanceof TypeError
    || error instanceof AttachmentsError && (error.status === 408 || error.status === 429 || error.status >= 500)
}
export function attachmentAttemptEndpoint(endpoint: AttachmentsEndpoint, signal: AbortSignal): AttachmentsEndpoint {
  return { ...endpoint, fetch: (input, init) => (endpoint.fetch ?? fetch)(input, {
    ...init, signal: init?.signal ? linkedAttachmentSignal([signal, init.signal]) : signal,
  }), upload: (url, init, progress) => (endpoint.upload ?? xhrAttachmentUpload)(url, {
    ...init, signal: init.signal ? linkedAttachmentSignal([signal, init.signal]) : signal,
  }, progress) }
}
export async function retryAttachmentUpload<T>(run: (attempt: number) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try { return await run(attempt) } catch (error) {
      if (attempt >= MAX_ATTEMPTS || !retryableAttachmentError(error)) throw error
      await new Promise(resolve => setTimeout(resolve, attempt * 500))
    }
  }
}
