import { coreLogger } from '../log'
import { isTransientNetworkError, transientNetworkErrorCode } from '../shared/networkError'

const log = coreLogger('attachment-download')
const delays = [0, 500, 2000] as const
export function isDownloadConnectionError(error: unknown): boolean {
  if ((error as { name?: unknown } | null)?.name === 'AbortError' || typeof (error as { status?: unknown } | null)?.status === 'number') return false
  // A terminated undici response body carries its socket cause rather than "fetch failed".
  return isTransientNetworkError(error) || transientNetworkErrorCode(error) === 'UND_ERR_SOCKET'
}
const safeMessage = (error: unknown) => String(error instanceof Error ? error.message : error)
  .replace(/https?:\/\/[^\s"'<>]+/gi, url => { try { return new URL(url).host } catch { return '[URL]' } })
  .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
type Hop = { stage: 'metadata' | 'signature' | 'cdn' | 'oss'; url: string }
export class FileDownloadFailure extends Error {
  readonly code: string
  readonly status?: number
  readonly host: string
  constructor(readonly stage: Hop['stage'], url: string, readonly elapsedMs: number, error: unknown) {
    const raw = transientNetworkErrorCode(error)
    const code = raw && /^[a-z0-9_]{1,64}$/i.test(raw) ? raw : isDownloadConnectionError(error) ? 'NETWORK_ERROR' : 'DOWNLOAD_ERROR'
    let host = 'unknown'
    try { host = new URL(url).host } catch { /* Never include a malformed signed URL. */ }
    super(`Attachment ${stage} failed on ${host} after ${elapsedMs}ms (${code}): ${safeMessage(error)}`,
      { cause: Object.assign(new Error(code), { code }) })
    this.name = 'FileDownloadFailure'; this.code = code; this.host = host
    const status = (error as { status?: unknown } | null)?.status
    if (typeof status === 'number') this.status = status
  }
}
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const aborted = () => { clearTimeout(timer); signal?.removeEventListener('abort', aborted); reject(signal?.reason) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', aborted); resolve() }, ms)
    signal?.addEventListener('abort', aborted, { once: true })
  })
}
/** Only authenticated file-read requests and the existing chunk reader use this budget. */
export async function retryFileDownload<T>(hop: () => Hop, action: () => Promise<T>, signal?: AbortSignal, prepareRetry?: () => Promise<void>): Promise<T> {
  let failure: FileDownloadFailure | undefined
  for (const [attempt, delay] of delays.entries()) {
    signal?.throwIfAborted()
    if (delay) await wait(delay, signal)
    const target = hop(), started = Date.now()
    try { return await action() } catch (error) {
      signal?.throwIfAborted()
      if ((error as { name?: unknown } | null)?.name === 'AbortError' || error instanceof FileDownloadFailure) throw error
      // Keep typed authorization/validation refusals intact for existing callers.
      if (!isDownloadConnectionError(error) && typeof (error as { status?: unknown } | null)?.status === 'number') throw error
      failure = new FileDownloadFailure(target.stage, target.url, Date.now() - started, error)
      log.warn({ stage: failure.stage, host: failure.host, elapsedMs: failure.elapsedMs, code: failure.code, attempt: attempt + 1 }, 'attachment request failed')
      if (!isDownloadConnectionError(error) || attempt === delays.length - 1) throw failure
      await prepareRetry?.()
    }
  }
  throw failure!
}
