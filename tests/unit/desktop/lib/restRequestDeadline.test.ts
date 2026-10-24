// @vitest-environment jsdom
// 数据面 REST 请求有期限:连接悄悄断了的请求要响亮失败,不能永远挂着冻住修订派发和历史窗口(岳 10-08)。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { REST_NETWORK_TIMEOUT_MS, authBoundedFetch, isLifecycleCancellation } from '../../../../apps/desktop/src/lib/authBoundedFetch'
import { abortAuthSessionBoundary, resetAuthSessionBoundary } from '../../../../apps/desktop/src/lib/authSessionLoss'
import { createGuguSupabaseClient } from '@gugu/core/cloud/supabase'

// 一个永远不回包的连接:只有 signal 中止时才失败。新内核以 signal 的原因失败;WebView <116 的 fetch 不管原因,
// 一律抛「The user aborted a request.」的 AbortError(mac1 WebView 113 实测)。
function deadConnection({ ignoresAbortReason = false } = {}) {
  return vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(ignoresAbortReason
      ? new DOMException('The user aborted a request.', 'AbortError')
      : init.signal!.reason), { once: true })
  }))
}

// Chromium can reject a body read as AbortError even when the signal's reason is TimeoutError.
function headersWithoutBody() {
  return vi.fn((_input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('['))
      init?.signal?.addEventListener('abort', () => controller.error(new DOMException('The user aborted a request.', 'AbortError')), { once: true })
    },
  }), { headers: { 'Content-Type': 'application/json' } })))
}

function controllableTimeouts() {
  const timers: Array<{ ms: number; fire: () => void }> = []
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
    const controller = new AbortController()
    timers.push({ ms, fire: () => controller.abort(new DOMException('signal timed out', 'TimeoutError')) })
    return controller.signal
  })
  return timers
}

// WebView <116 没有 AbortSignal.any:删掉它,authBoundedFetch 走自己合并 signal 的降级分支。
function withoutAbortSignalAny() {
  const native = Object.getOwnPropertyDescriptor(AbortSignal, 'any')
  delete (AbortSignal as { any?: unknown }).any
  expect(typeof AbortSignal.any).toBe('undefined')
  return () => { if (native) Object.defineProperty(AbortSignal, 'any', native) }
}

let restoreAbortSignalAny: (() => void) | null = null
afterEach(() => {
  restoreAbortSignalAny?.()
  restoreAbortSignalAny = null
  resetAuthSessionBoundary()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('authBoundedFetch data-plane deadline', () => {
  it('returns a completed REST body with its status and headers intact', async () => {
    controllableTimeouts()
    const response = new Response('[{"id":"x"}]', { status: 206, statusText: 'Partial Content', headers: { 'Content-Range': '0-0/1' } })
    vi.stubGlobal('fetch', vi.fn(async () => response))
    const result = await authBoundedFetch('https://db.example.test/rest/v1/messages_view')
    expect(result.status).toBe(206)
    expect(result.statusText).toBe('Partial Content')
    expect(result.headers.get('Content-Range')).toBe('0-0/1')
    expect(await result.json()).toEqual([{ id: 'x' }])
  })

  it('keeps a bodyless REST response bodyless', async () => {
    controllableTimeouts()
    const response = new Response(null, { status: 204 })
    vi.stubGlobal('fetch', vi.fn(async () => response))
    expect(await authBoundedFetch('https://db.example.test/rest/v1/messages_view')).toBe(response)
  })

  it('returns storage streams without consuming their body', async () => {
    controllableTimeouts()
    const response = new Response(new ReadableStream())
    vi.stubGlobal('fetch', vi.fn(async () => response))
    expect(await authBoundedFetch('https://db.example.test/storage/v1/object/chat-media/a.png')).toBe(response)
    expect(response.bodyUsed).toBe(false)
  })

  it('fails a hung /rest/v1 request loudly once the REST deadline passes', async () => {
    const timers = controllableTimeouts()
    vi.stubGlobal('fetch', deadConnection())
    const pending = authBoundedFetch('https://db.example.test/rest/v1/messages_view?chat_id=eq.x')
    expect(timers.map((timer) => timer.ms)).toEqual([REST_NETWORK_TIMEOUT_MS])
    timers[0]!.fire()
    const error = await pending.catch((reason: unknown) => reason)
    expect((error as DOMException).name).toBe('TimeoutError')
    expect(isLifecycleCancellation(error)).toBe(false)
  })

  it('puts no deadline on storage transfers', async () => {
    const timers = controllableTimeouts()
    vi.stubGlobal('fetch', deadConnection())
    void authBoundedFetch('https://db.example.test/storage/v1/object/chat-media/a.png').catch(() => {})
    expect(timers).toEqual([])
  })
})

describe('authBoundedFetch without AbortSignal.any (WebView <116)', () => {
  it('still fails a hung request as TimeoutError, not as a lifecycle cancellation', async () => {
    restoreAbortSignalAny = withoutAbortSignalAny()
    const timers = controllableTimeouts()
    vi.stubGlobal('fetch', deadConnection({ ignoresAbortReason: true }))
    const pending = authBoundedFetch('https://db.example.test/rest/v1/messages_view?chat_id=eq.x')
    timers[0]!.fire()
    const error = await pending.catch((reason: unknown) => reason)
    expect((error as DOMException).name).toBe('TimeoutError')
    expect(isLifecycleCancellation(error)).toBe(false)
  })

  it('keeps a session-boundary abort a quiet lifecycle cancellation', async () => {
    restoreAbortSignalAny = withoutAbortSignalAny()
    controllableTimeouts()
    vi.stubGlobal('fetch', deadConnection({ ignoresAbortReason: true }))
    const pending = authBoundedFetch('https://db.example.test/rest/v1/messages_view?chat_id=eq.x')
    abortAuthSessionBoundary()
    const error = await pending.catch((reason: unknown) => reason)
    expect((error as DOMException).name).toBe('AbortError')
    expect(isLifecycleCancellation(error)).toBe(true)
  })

  it('keeps a caller abort a quiet lifecycle cancellation', async () => {
    restoreAbortSignalAny = withoutAbortSignalAny()
    controllableTimeouts()
    vi.stubGlobal('fetch', deadConnection({ ignoresAbortReason: true }))
    const caller = new AbortController()
    const pending = authBoundedFetch('https://db.example.test/rest/v1/messages_view?chat_id=eq.x', { signal: caller.signal })
    caller.abort()
    const error = await pending.catch((reason: unknown) => reason)
    expect((error as DOMException).name).toBe('AbortError')
    expect(isLifecycleCancellation(error)).toBe(true)
  })
})

// 真的 supabase-js / postgrest-js 客户端,和 apps/desktop/src/lib/supabase.ts 的数据客户端同一种拼法。
// postgrest-js 对 GET 的 fetch 抛错自带重试(1/2/4s 退避 3 次);超时要只失败一次,抖动照旧重试。
// 钉的是 postgrest-js executeWithRetry 对 code==='ABORT_ERR' 不重试:升级 postgrest-js 时这里红了,先看那条判断。
describe('authBoundedFetch under the real PostgREST client', () => {
  function dataClient() {
    return createGuguSupabaseClient({ url: 'https://db.example.test', anonKey: 'anon', accessToken: async () => null, fetch: authBoundedFetch })
  }

  it.each([false, true])('classifies a body deadline as TimeoutError without retrying (compatibility: %s)', async (compatibility) => {
    if (compatibility) restoreAbortSignalAny = withoutAbortSignalAny()
    vi.useFakeTimers()
    const timers = controllableTimeouts()
    const fetch = headersWithoutBody()
    vi.stubGlobal('fetch', fetch)
    const read = dataClient().from('messages_view').select('*').then((result) => result)
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledTimes(1)
    timers[0]!.fire()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fetch).toHaveBeenCalledTimes(1)
    const { error } = await read
    expect(error?.message).toMatch(/^TimeoutError: /)
    expect(isLifecycleCancellation(new Error(error!.message))).toBe(false)
  })

  it.each(['session', 'caller'] as const)('keeps a genuine %s cancellation during body reading quiet', async (source) => {
    restoreAbortSignalAny = withoutAbortSignalAny()
    vi.useFakeTimers()
    controllableTimeouts()
    const caller = new AbortController()
    const fetch = headersWithoutBody()
    vi.stubGlobal('fetch', fetch)
    const read = dataClient().from('messages_view').select('*').abortSignal(caller.signal).then((result) => result)
    await vi.advanceTimersByTimeAsync(0)
    if (source === 'session') abortAuthSessionBoundary()
    else caller.abort()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fetch).toHaveBeenCalledTimes(1)
    const { error } = await read
    expect(error?.message).toMatch(/^AbortError: /)
    expect(isLifecycleCancellation(new Error(error!.message))).toBe(true)
  })

  it('fails a hung read once, as TimeoutError, without postgrest stacking more 30 s attempts', async () => {
    vi.useFakeTimers()
    const timers = controllableTimeouts()
    const fetch = deadConnection()
    vi.stubGlobal('fetch', fetch)
    const read = dataClient().from('messages_view').select('*').then((result) => result)
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledTimes(1)
    timers[0]!.fire()
    await vi.advanceTimersByTimeAsync(10_000)
    // 先数再 await:若 postgrest 重试了,第二次 fetch 又挂在一个新的 30s 期限上,await 会永远等下去。
    expect(fetch).toHaveBeenCalledTimes(1)
    const { error } = await read
    expect(error?.message).toMatch(/^TimeoutError: /)
    expect(isLifecycleCancellation(new Error(error!.message))).toBe(false)
  })

  it('still lets postgrest retry a fast network failure (3 retries)', async () => {
    vi.useFakeTimers()
    controllableTimeouts()
    const fetch = vi.fn(async () => { throw new TypeError('Failed to fetch') })
    vi.stubGlobal('fetch', fetch)
    const read = dataClient().from('messages_view').select('*').then((result) => result)
    await vi.advanceTimersByTimeAsync(10_000)
    const { error } = await read
    expect(fetch).toHaveBeenCalledTimes(4)
    expect(error?.message).toMatch(/^TypeError: /)
  })
})
