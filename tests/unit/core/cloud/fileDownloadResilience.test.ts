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
function fixture(options: { origin?: boolean; expired?: boolean; signerFails?: boolean; thumbnail?: boolean } = {}) {
  const cache = new Map<number, Uint8Array>(), committed = vi.fn(), requests: Record<string, unknown>[] = []
  const object = vi.fn<typeof fetch>(async (_url, init) => {
    const offset = Number(new Headers(init?.headers).get('Range')?.match(/bytes=(\d+)-/)?.[1] ?? 0)
    return new Response(bytes.slice(offset), { status: offset ? 206 : 200, headers: offset ? { 'content-range': `bytes ${offset}-${bytes.length - 1}/${bytes.length}` } : {} })
  })
  let signed = 0
  const api = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith('/file-resolve')) return Response.json({ ...revision, status: 'ready' })
    const body = JSON.parse(String(init?.body)); requests.push(body); signed++
    if (body.origin && options.signerFails) return Response.json({ error: 'signing_failed', message: 'Origin signing failed' }, { status: 503 })
    return Response.json({ status: 'ready', url: body.origin ? `https://oss.invalid/file?x-oss-signature=secret-${signed}` : `https://cdn.invalid/file?auth_key=secret-${signed}`,
      ...(options.origin && !body.origin ? { origin_available: true } : {}),
      ...(options.thumbnail ? { thumb_url: 'https://cdn.invalid/thumb.png' } : {}),
      expires_at: new Date(Date.now() + (options.expired && signed === 1 ? -1 : 60_000)).toISOString(),
      size_bytes: bytes.length, sha256: revision.sha256, download_id: body.request_id })
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
it('keeps a healthy CDN download independent of a failing optional origin signer', async () => {
  const f = fixture({ origin: true, signerFails: true })
  value(await finish(f.cloud.managed(revision, context)))
  expect(f.requests).toHaveLength(1); expect(f.requests[0]).not.toHaveProperty('origin')
  expect(f.object.mock.calls.map(([url]) => new URL(String(url)).host)).toEqual(['cdn.invalid'])
  expect(f.committed).toHaveBeenCalledTimes(1)
})
it('requests an origin signature only after the CDN fails, using the existing reservation', async () => {
  const f = fixture({ origin: true }); let cdnFailed = false
  f.object.mockImplementationOnce(async () => { cdnFailed = true; throw network('ETIMEDOUT') })
  f.api.mockImplementationOnce(async () => {
    expect(cdnFailed).toBe(false)
    return Response.json({ status: 'ready', url: 'https://cdn.invalid/file', origin_available: true, download_id: 'reservation', size_bytes: bytes.length, sha256: revision.sha256 })
  })
  value(await finish(f.cloud.managed(revision, context)))
  expect(cdnFailed).toBe(true)
  expect(f.requests).toEqual([expect.objectContaining({ origin: true, request_id: 'reservation' })])
  expect(f.object.mock.calls.map(([url]) => new URL(String(url)).host)).toEqual(['cdn.invalid', 'oss.invalid'])
})
it('fails explicitly when the needed origin signature is refused after a real CDN failure', async () => {
  const f = fixture({ origin: true, signerFails: true }); f.object.mockRejectedValueOnce(network())
  const result = await finish(f.cloud.managed(revision, context))
  expect(result).toHaveProperty('error', expect.objectContaining({ status: 503, code: 'signing_failed' }))
  expect(f.requests).toHaveLength(14)
  expect(f.requests[1]).toMatchObject({ origin: true, request_id: f.requests[0]!.request_id })
  expect(f.object).toHaveBeenCalledTimes(1); expect(f.committed).not.toHaveBeenCalled()
})
it('does not ask for origin access to bypass an unexpired CDN refusal', async () => {
  const f = fixture({ origin: true }); f.object.mockResolvedValueOnce(new Response(null, { status: 403 }))
  expect(await finish(f.cloud.managed(revision, context))).toHaveProperty('error', expect.any(Error))
  expect(f.requests).toHaveLength(1); expect(f.object).toHaveBeenCalledTimes(1)
  expect(f.committed).not.toHaveBeenCalled()
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
  const result = await finish(f.cloud.managed(revision, context)); expect(f.object).toHaveBeenCalledTimes(13)
  expect(result).toHaveProperty('error', expect.objectContaining({ stage: 'cdn', host: 'cdn.invalid', code: 'ETIMEDOUT', elapsedMs: expect.any(Number), cause: expect.objectContaining({ code: 'ETIMEDOUT' }) }))
  expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('do-not-log')
  if ('error' in result) expect(String(result.error)).not.toContain('do-not-log')
  expect(f.committed).not.toHaveBeenCalled()
})
it.each(['connection', 'service'])('retains complete chunks after exhausting %s retries and resumes them on a later read', async failure => {
  const f = fixture(); let reads = 0
  f.object.mockResolvedValueOnce(new Response(new ReadableStream({ pull(controller) {
    if (reads++ === 0) controller.enqueue(bytes.slice(0, 524288 + 20))
    else controller.error(network('UND_ERR_SOCKET'))
  } }))).mockImplementation(async () => {
    if (failure === 'connection') throw network()
    return new Response(null, { status: 503 })
  })
  expect(await finish(f.cloud.managed(revision, context))).toHaveProperty('error', expect.any(Error))
  expect(f.cache.size).toBe(1); expect(f.committed).not.toHaveBeenCalled()
  f.object.mockImplementation(async (_url, init) => {
    const offset = Number(new Headers(init?.headers).get('Range')?.match(/bytes=(\d+)-/)?.[1] ?? 0)
    return new Response(bytes.slice(offset), { status: offset ? 206 : 200, headers: offset ? { 'content-range': `bytes ${offset}-${bytes.length - 1}/${bytes.length}` } : {} })
  })
  const resumed = value(await finish(f.cloud.managed(revision, context)))
  expect(f.object).toHaveBeenCalledTimes(14)
  expect(f.object.mock.calls.slice(1).map(([, init]) => new Headers(init?.headers).get('Range'))).toEqual(Array(13).fill('bytes=524288-'))
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
  expect(f.api).toHaveBeenCalledTimes(14); expect(f.object).toHaveBeenCalledTimes(1)
})
it('bounds an exhausted lazy origin-signing request without retrying the byte operation again', async () => {
  const f = fixture({ origin: true }); f.object.mockImplementationOnce(async () => {
    f.api.mockRejectedValue(network()); throw network('ETIMEDOUT')
  })
  expect(await finish(f.cloud.managed(revision, context))).toHaveProperty('error', expect.objectContaining({ stage: 'signature' }))
  expect(f.api).toHaveBeenCalledTimes(14); expect(f.object).toHaveBeenCalledTimes(1)
  const origin = f.api.mock.calls.slice(1).map(([, init]) => JSON.parse(String(init?.body)))
  expect(origin).toHaveLength(13)
  expect(origin.every(body => body.origin === true && body.request_id === f.requests[0]!.request_id)).toBe(true)
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

it.each([408, 429, 500, 502, 503, 599].flatMap(status => ['file-resolve', 'file-download'].map(route => ({ status, route }))))('keeps $route pending through a 60-second HTTP $status outage and recovers automatically', async ({ status, route }) => {
  const f = fixture(), started = Date.now(), settled = vi.fn()
  f.api.mockImplementation(async () => Date.now() - started < 60_000
    ? Response.json({ error: 'temporary' }, { status }) : Response.json({ ...revision, status: 'ready' }))
  const work = attachmentRequest(f.endpoint, route, { request_id: 'same-reservation' }); void work.then(settled, settled)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(settled).not.toHaveBeenCalled()
  await vi.runAllTimersAsync()
  expect(await work).toMatchObject({ status: 'ready' })
  expect(settled).toHaveBeenCalledTimes(1)
  expect(Date.now() - started).toBeGreaterThanOrEqual(60_000)
  expect(Date.now() - started).toBeLessThanOrEqual(90_000)
  expect(new Set(f.api.mock.calls.map(([, init]) => String(init?.body))).size).toBe(1)
})
it('only rejects a persistent HTTP outage after the 90-second final retry', async () => {
  const f = fixture(), started = Date.now(), settled = vi.fn(), attempts: number[] = []
  f.api.mockImplementation(async () => { attempts.push(Date.now() - started); return Response.json({ error: 'busy' }, { status: 503 }) })
  const work = f.cloud.metadata(context).then(settled, error => { settled(error); return error })
  await vi.advanceTimersByTimeAsync(89_999)
  expect(settled).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(await work).toMatchObject({ status: 503, code: 'busy' })
  expect(settled).toHaveBeenCalledTimes(1)
  expect(attempts[0]).toBe(0); expect(attempts.at(-1)).toBe(90_000)
  expect(Math.max(...attempts.slice(1).map((time, i) => time - attempts[i]!))).toBeLessThanOrEqual(10_000)
})
it('recovers original bytes after a 60-second object-service outage without publishing partial bytes', async () => {
  const f = fixture(), started = Date.now()
  f.object.mockImplementation(async (_url, init) => {
    if (Date.now() - started < 60_000) return new Response(null, { status: 503 })
    const offset = Number(new Headers(init?.headers).get('Range')?.match(/bytes=(\d+)-/)?.[1] ?? 0)
    return new Response(bytes.slice(offset), { status: offset ? 206 : 200, headers: offset ? { 'content-range': `bytes ${offset}-${bytes.length - 1}/${bytes.length}` } : {} })
  })
  const work = f.cloud.managed(revision, context)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(f.committed).not.toHaveBeenCalled()
  const file = value(await finish(work))
  expect(file.size).toBe(bytes.length); expect(f.committed).toHaveBeenCalledTimes(1)
})
it('retries thumbnail responses and their bodies through the same window', async () => {
  const f = fixture({ thumbnail: true }), started = Date.now(), settled = vi.fn()
  f.object.mockImplementation(async () => Date.now() - started < 60_000
    ? new Response(null, { status: 503 }) : new Response(new Blob(['pixels'], { type: 'image/png' })))
  const work = f.cloud.preview!({ ...revision, content_type: 'image/png' }, context, vi.fn()); void work.then(settled, settled)
  await vi.advanceTimersByTimeAsync(60_000); expect(settled).not.toHaveBeenCalled()
  const preview = value(await finish(work)); expect(preview).toBeInstanceOf(Blob)
  expect(f.object.mock.calls.every(([url]) => String(url).endsWith('/thumb.png'))).toBe(true)
})
it('never retries a thumbnail permission refusal', async () => {
  const f = fixture({ thumbnail: true }); f.object.mockResolvedValue(new Response(null, { status: 403 }))
  expect(await finish(f.cloud.preview!({ ...revision, content_type: 'image/png' }, context, vi.fn()))).toHaveProperty('error', expect.objectContaining({ status: 403 }))
  expect(f.object).toHaveBeenCalledTimes(1)
})
it.each(['Failed to fetch', 'Load failed', 'NetworkError when attempting to fetch resource.'])('recovers browser connection failures: %s', async message => {
  const f = fixture(); f.api.mockRejectedValueOnce(new TypeError(message))
  value(await finish(f.cloud.managed(revision, context)))
  expect(f.committed).toHaveBeenCalledTimes(1)
})
