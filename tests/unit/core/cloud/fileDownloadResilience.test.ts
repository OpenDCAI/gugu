import { createHash } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cloudFileProviders } from '../../../../packages/core/src/cloud/fileProviders'
import { attachmentRequest, AttachmentsError } from '../../../../packages/core/src/cloud/attachmentsApi'
import { setCoreLoggerFactory } from '../../../../packages/core/src/log'
import type { FileSink } from '../../../../packages/core/src/shared/fileCipher'
import type { FileRevision } from '../../../../packages/core/src/shared/fileResolver'

const bytes = new Uint8Array(600_000).fill(53)
const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')
const revision: FileRevision = { source: 'managed-object', item_id: 'file', version: 1, chat_id: 'chat', file_name: 'test.bin', content_type: 'application/octet-stream', size_bytes: bytes.length, sha256: sha(bytes) }
const context = { ref: { item_id: 'file' }, actor: { actorId: 'reader', accountId: 'owner' } }
const network = (code = 'ECONNRESET') => new TypeError('fetch failed', { cause: Object.assign(new Error('socket'), { code }) })
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
let restoreLog: () => void
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-03T00:00:00Z')); restoreLog = setCoreLoggerFactory(() => logger) })
afterEach(() => { restoreLog(); vi.useRealTimers(); vi.clearAllMocks() })
function fixture(options: { origin?: boolean; expired?: boolean } = {}) {
  const cache = new Map<number, Uint8Array>(), committed = vi.fn(), requests: Record<string, unknown>[] = []
  const object = vi.fn<typeof fetch>(async (_url, init) => {
    const offset = Number(new Headers(init?.headers).get('Range')?.match(/bytes=(\d+)-/)?.[1] ?? 0)
    return new Response(bytes.slice(offset), { status: offset ? 206 : 200, headers: offset ? { 'content-range': `bytes ${offset}-${bytes.length - 1}/${bytes.length}` } : {} })
  })
  let signed = 0
  const api = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith('/file-resolve')) return Response.json({ ...revision, status: 'ready' })
    const body = JSON.parse(String(init?.body)); requests.push(body); signed++
    return Response.json({ status: 'ready', url: `https://cdn.invalid/file?auth_key=secret-${signed}`,
      ...(options.origin ? { origin_url: `https://oss.invalid/file?x-oss-signature=secret-${signed}` } : {}),
      expires_at: new Date(Date.now() + (options.expired && signed === 1 ? -1 : 60_000)).toISOString(),
      size_bytes: bytes.length, sha256: revision.sha256, download_id: `download-${signed}` })
  })
  const endpoint = { supabaseUrl: 'https://signer.invalid', anonKey: 'fixture', token: 'fixture', fetch: api }
  const sink = async (): Promise<FileSink> => {
    const chunks: Uint8Array[] = []
    return { write: async part => { chunks.push(part.slice()) }, abort: async () => {}, commit: async () => {
      const joined = Buffer.concat(chunks); committed(); return { size: joined.length, read: async (offset, length) => joined.subarray(offset, offset + length), dispose: async () => {} }
    } }
  }
  const cloud = cloudFileProviders({ endpoint: async () => endpoint, fetch: object, sink,
    cache: { get: async (_key, index) => cache.get(index) ?? null, put: async (_key, index, part) => { cache.set(index, part.slice()) }, clear: async () => cache.clear() } })
  return { cloud, api, object, endpoint, requests, cache, committed }
}
async function finish<T>(promise: Promise<T>) { const result = promise.then(value => ({ value }), error => ({ error })); await vi.runAllTimersAsync(); return result }
function value<T>(result: { value: T } | { error: unknown }): T { if ('error' in result) throw result.error; return result.value }

it('retries the same authenticated signing reservation twice at 500/2000ms', async () => {
  const f = fixture(); f.api.mockRejectedValueOnce(network()).mockRejectedValueOnce(network('UND_ERR_CONNECT_TIMEOUT'))
  const work = f.cloud.managed(revision, context), settled = vi.fn(); void work.then(settled, () => undefined)
  await vi.advanceTimersByTimeAsync(499); expect(f.api).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1); expect(f.api).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(1999); expect(f.api).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(1); const file = await work
  expect(settled).toHaveBeenCalledTimes(1)
  const signing = f.api.mock.calls.filter(([url]) => String(url).endsWith('/file-download'))
  expect(signing).toHaveLength(3)
  expect(new Set(signing.map(([, init]) => JSON.parse(String(init?.body)).request_id)).size).toBe(1)
  expect(sha(await file.read(0, 524288))).toBe(sha(bytes.subarray(0, 524288)))
})
it('switches to the separately signed OSS URL on a CDN connection failure and preserves hash verification', async () => {
  const f = fixture({ origin: true }); f.object.mockRejectedValueOnce(network('ETIMEDOUT'))
  const file = value(await finish(f.cloud.managed(revision, context)))
  expect(f.object.mock.calls.map(([url]) => new URL(String(url)).host)).toEqual(['cdn.invalid', 'oss.invalid'])
  expect(f.committed).toHaveBeenCalledTimes(1); expect(file.size).toBe(bytes.length)
  expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret-')
})
it('restarts only the interrupted chunk at its existing offset after a response body connection failure', async () => {
  const f = fixture({ origin: true }); let reads = 0
  f.object.mockResolvedValueOnce(new Response(new ReadableStream({ pull(controller) {
    if (reads++ === 0) controller.enqueue(bytes.slice(0, 524288 + 20))
    else controller.error(network('UND_ERR_SOCKET'))
  } })))
  const file = value(await finish(f.cloud.managed(revision, context)))
  expect(f.object.mock.calls[1]?.[0]).toContain('oss.invalid')
  expect(new Headers(f.object.mock.calls[1]?.[1]?.headers).get('Range')).toBe('bytes=524288-')
  expect(f.cache.get(0)).toEqual(bytes.subarray(0, 524288))
  expect(sha(Buffer.concat([await file.read(0, 524288), await file.read(524288, bytes.length - 524288)]))).toBe(revision.sha256)
})
it('bounds connection retries with an old backend that has no origin URL and reports the failing hop safely', async () => {
  const f = fixture(); f.object.mockRejectedValue(new TypeError('fetch failed https://cdn.invalid/file?auth_key=do-not-log', { cause: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) }))
  const result = await finish(f.cloud.managed(revision, context)); expect(f.object).toHaveBeenCalledTimes(3)
  expect(result).toHaveProperty('error', expect.objectContaining({ stage: 'cdn', host: 'cdn.invalid', code: 'ETIMEDOUT', elapsedMs: expect.any(Number), cause: expect.objectContaining({ code: 'ETIMEDOUT' }) }))
  expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('do-not-log')
  if ('error' in result) expect(String(result.error)).not.toContain('do-not-log')
  expect(f.committed).not.toHaveBeenCalled()
})
it('retains complete chunks after exhausting retries and resumes them on a later read', async () => {
  const f = fixture(); let reads = 0
  f.object.mockResolvedValueOnce(new Response(new ReadableStream({ pull(controller) {
    if (reads++ === 0) controller.enqueue(bytes.slice(0, 524288 + 20))
    else controller.error(network('UND_ERR_SOCKET'))
  } }))).mockRejectedValueOnce(network()).mockRejectedValueOnce(network())
  expect(await finish(f.cloud.managed(revision, context))).toHaveProperty('error', expect.any(Error))
  expect(f.cache.size).toBe(1); expect(f.committed).not.toHaveBeenCalled()
  const resumed = value(await finish(f.cloud.managed(revision, context)))
  expect(f.object).toHaveBeenCalledTimes(4)
  expect(f.object.mock.calls.slice(1).map(([, init]) => new Headers(init?.headers).get('Range'))).toEqual(Array(3).fill('bytes=524288-'))
  expect(sha(Buffer.concat([await resumed.read(0, 524288), await resumed.read(524288, bytes.length - 524288)]))).toBe(revision.sha256)
})
it('redacts signed URLs from a non-connection failure without retrying it', async () => {
  const f = fixture(); f.object.mockRejectedValue(new TypeError('Invalid URL https://cdn.invalid/file?auth_key=do-not-log'))
  const result = await finish(f.cloud.managed(revision, context))
  expect(result).toHaveProperty('error', expect.objectContaining({ stage: 'cdn', code: 'DOWNLOAD_ERROR' }))
  expect(String('error' in result && result.error)).not.toContain('do-not-log')
  expect(f.object).toHaveBeenCalledTimes(1); expect(f.committed).not.toHaveBeenCalled()
})
it('never retries authentication refusals or mutating attachment operations', async () => {
  const f = fixture(); f.api.mockResolvedValue(Response.json({ error: 'denied', message: 'Access denied' }, { status: 403 }))
  const result = await finish(f.cloud.managed(revision, context)); expect(result).toHaveProperty('error', expect.objectContaining({ status: 403, code: 'denied' }))
  if ('error' in result) expect(result.error).toBeInstanceOf(AttachmentsError)
  expect(f.api).toHaveBeenCalledTimes(1); expect(f.object).not.toHaveBeenCalled()
  f.api.mockRejectedValue(network()); await expect(attachmentRequest(f.endpoint, 'commit', {})).rejects.toThrow('fetch failed')
  expect(f.api).toHaveBeenCalledTimes(2)
})
it('renews an expired signed URL once while keeping an unexpired 403 as a refusal', async () => {
  for (const expired of [true, false]) {
    const f = fixture({ expired }); f.object.mockResolvedValueOnce(new Response(null, { status: 403 }))
    const result = await finish(f.cloud.managed(revision, context))
    expect(f.requests).toHaveLength(expired ? 2 : 1)
    expect(f.object).toHaveBeenCalledTimes(expired ? 2 : 1)
    if (expired) { value(result); expect(f.requests[0]?.request_id).not.toBe(f.requests[1]?.request_id) }
    else expect(result).toHaveProperty('error', expect.any(Error))
  }
})
it('does not keep renewing or retrying a denied renewed capability', async () => {
  const f = fixture({ expired: true }); f.object.mockResolvedValue(new Response(null, { status: 403 }))
  expect(await finish(f.cloud.managed(revision, context))).toHaveProperty('error', expect.any(Error))
  expect(f.requests).toHaveLength(2); expect(f.object).toHaveBeenCalledTimes(2)
})
it('does not multiply exhausted signing retries inside the byte retry budget', async () => {
  const f = fixture({ expired: true }); f.object.mockImplementationOnce(async () => {
    f.api.mockRejectedValue(network()); return new Response(null, { status: 403 })
  })
  expect(await finish(f.cloud.managed(revision, context))).toHaveProperty('error', expect.objectContaining({ stage: 'signature' }))
  expect(f.api).toHaveBeenCalledTimes(4); expect(f.object).toHaveBeenCalledTimes(1)
})
it('aborts a retry backoff immediately without another network attempt', async () => {
  const f = fixture({ origin: true }), abort = new AbortController(); f.object.mockRejectedValue(network())
  const work = f.cloud.managed(revision, { ...context, signal: abort.signal }).then(value => ({ value }), error => ({ error }))
  await vi.advanceTimersByTimeAsync(0); abort.abort(new DOMException('Stopped', 'AbortError'))
  expect(await work).toHaveProperty('error', expect.objectContaining({ name: 'AbortError' }))
  expect(f.object).toHaveBeenCalledTimes(1); expect(f.committed).not.toHaveBeenCalled()
})
it('aborts signature backoff without waiting for the retry timer', async () => {
  const f = fixture(), abort = new AbortController(); f.api.mockRejectedValue(network())
  const work = f.cloud.managed(revision, { ...context, signal: abort.signal }).then(value => ({ value }), error => ({ error }))
  await vi.advanceTimersByTimeAsync(0); abort.abort(new DOMException('Stopped', 'AbortError'))
  expect(await work).toHaveProperty('error', expect.objectContaining({ name: 'AbortError' }))
  expect(f.api).toHaveBeenCalledTimes(1); expect(f.object).not.toHaveBeenCalled()
})
