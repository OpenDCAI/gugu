import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { OpenedFileChangedError, readWholeOpenedFile } from '../../../apps/desktop/src/mobile/agent-watch/opened-output-open'

vi.mock('../../../apps/desktop/src/mobile/agent-watch/sessionpage-rpc', () => ({
  SessionpageRpcError: class extends Error { constructor(readonly code: string, message: string) { super(message) } },
}))

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0) })
afterEach(() => { vi.useRealTimers() })
const input = { conversationId: 'task', path: '/workspace/report.txt', retryTransient: true }
const transient = () => Object.assign(new Error('temporary read failure'), { status: 503 })
const chunk = (data = 'YWJj', size = 3, etag = 'version-1') => ({ data, size, etag })
const outcome = <T,>(work: Promise<T>) => work.then(value => ({ value }), error => ({ error }))

it('keeps an initiated download pending through a 60-second outage and recovers without a manual retry', async () => {
  const read = vi.fn(async () => { if (Date.now() < 60_000) throw transient(); return chunk() })
  let settled = false
  const work = outcome(readWholeOpenedFile({ ...input, read })).then(result => { settled = true; return result })
  await vi.advanceTimersByTimeAsync(59_999)
  expect(settled).toBe(false)
  await vi.advanceTimersByTimeAsync(10_001)
  expect(await work).toEqual({ value: new TextEncoder().encode('abc') })
  expect(read.mock.calls.length).toBeGreaterThan(2)
})

it('exhausts persistent transient errors after 90 seconds and leaves no retry timer', async () => {
  const error = transient(), read = vi.fn(async () => { throw error })
  let settled = false
  const work = outcome(readWholeOpenedFile({ ...input, read })).then(result => { settled = true; return result })
  await vi.advanceTimersByTimeAsync(89_999)
  expect(settled).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect(await work).toEqual({ error })
  const attempts = read.mock.calls.length
  await vi.advanceTimersByTimeAsync(100_000)
  expect(read).toHaveBeenCalledTimes(attempts)
  expect(vi.getTimerCount()).toBe(0)
})

it.each([408, 429, 500, 503])('retries transient HTTP %s without changing the chunk request', async status => {
  const read = vi.fn().mockRejectedValueOnce(Object.assign(new Error('temporary'), { status })).mockResolvedValue(chunk())
  const work = readWholeOpenedFile({ ...input, read })
  await vi.advanceTimersByTimeAsync(500)
  expect(await work).toEqual(new TextEncoder().encode('abc'))
  expect(read.mock.calls[1][0]).toEqual(read.mock.calls[0][0])
})

it.each([{ status: 403 }, { code: 'EACCES' }, { code: 'file_missing' }, { code: 'not_opened' }, { code: 'server_outdated' }])('does not retry a permanent refusal %j', async detail => {
  const error = Object.assign(new Error('refused'), detail), read = vi.fn(async () => { throw error })
  expect(await outcome(readWholeOpenedFile({ ...input, read }))).toEqual({ error })
  expect(read).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it.each(['unreachable', 'timeout', 'ECONNRESET'])('retries the structured transport failure %s', async code => {
  const read = vi.fn().mockRejectedValueOnce(Object.assign(new Error('transport failed'), { code })).mockResolvedValue(chunk())
  const work = readWholeOpenedFile({ ...input, read })
  await vi.advanceTimersByTimeAsync(500)
  expect(await work).toEqual(new TextEncoder().encode('abc'))
})

it('cancels a backoff immediately when the caller closes the pending download', async () => {
  const controller = new AbortController(), reason = new Error('view closed'), read = vi.fn(async () => { throw transient() })
  const work = outcome(readWholeOpenedFile({ ...input, read, signal: controller.signal }))
  await vi.advanceTimersByTimeAsync(1)
  controller.abort(reason)
  expect(await work).toEqual({ error: reason })
  await vi.advanceTimersByTimeAsync(100_000)
  expect(read).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it('retains verified chunks and progress while retrying only the interrupted chunk', async () => {
  const progress = vi.fn()
  const read = vi.fn(async ({ offset }: { offset: number }) => {
    if (!offset) return chunk('YWJj', 6)
    if (Date.now() < 60_000) throw transient()
    return chunk('ZGVm', 6)
  })
  const work = readWholeOpenedFile({ ...input, read, onProgress: progress })
  await vi.advanceTimersByTimeAsync(70_000)
  expect(await work).toEqual(new TextEncoder().encode('abcdef'))
  expect(read.mock.calls.filter(([request]) => request.offset === 0)).toHaveLength(1)
  expect(progress.mock.calls).toEqual([[3, 6], [6, 6]])
})

it('still rejects a changed immutable version after recovering a failed chunk', async () => {
  const read = vi.fn().mockResolvedValueOnce(chunk('YWJj', 6)).mockRejectedValueOnce(transient()).mockResolvedValue(chunk('ZGVm', 6, 'version-2'))
  const work = outcome(readWholeOpenedFile({ ...input, read }))
  await vi.advanceTimersByTimeAsync(500)
  expect(await work).toEqual({ error: expect.any(OpenedFileChangedError) })
  expect(read).toHaveBeenCalledTimes(3)
})

it('leaves ordinary preview reads on their existing immediate failure path', async () => {
  const error = transient(), read = vi.fn(async () => { throw error })
  expect(await outcome(readWholeOpenedFile({ ...input, retryTransient: false, read }))).toEqual({ error })
  expect(read).toHaveBeenCalledOnce()
})
