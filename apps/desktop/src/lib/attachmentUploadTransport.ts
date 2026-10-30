import type { AttachmentUploadTransport } from '@gugu/core/cloud/attachmentsApi'

/** XHR's upload events report transferred request bytes; fetch has no browser upload-progress event. */
export const xhrAttachmentUpload: AttachmentUploadTransport = (url, init, onProgress) => new Promise((resolve, reject) => {
  const xhr = new XMLHttpRequest()
  const cleanup = () => {
    init.signal?.removeEventListener('abort', abort)
    xhr.onload = xhr.onerror = xhr.onabort = null
    xhr.upload.onprogress = null
  }
  const fail = (error: unknown) => { cleanup(); reject(error) }
  const abort = () => {
    cleanup()
    xhr.abort()
    reject(init.signal?.reason ?? new DOMException('Upload cancelled', 'AbortError'))
  }
  if (init.signal?.aborted) { abort(); return }
  xhr.upload.onprogress = event => onProgress?.({ loaded: event.loaded, total: event.lengthComputable ? event.total : undefined })
  xhr.onload = () => { cleanup(); resolve({ status: xhr.status }) }
  xhr.onerror = () => fail(new TypeError('Attachment upload network error'))
  xhr.onabort = () => fail(init.signal?.reason ?? new DOMException('Upload cancelled', 'AbortError'))
  init.signal?.addEventListener('abort', abort, { once: true })
  try {
    xhr.open(init.method, url)
    for (const [name, value] of Object.entries(init.headers ?? {})) xhr.setRequestHeader(name, value)
    xhr.send(init.body)
  } catch (error) { fail(error) }
})
