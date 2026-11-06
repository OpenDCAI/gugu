import { describe, expect, it, vi } from 'vitest'
import { loginOtpRequestPending, observeLoginOtpFetch, retryAfterSeconds, runLoginOtpRequest } from '../../../../apps/desktop/src/lib/loginOtpTransport'

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }

describe('OTP transport metadata and PKCE serialization', () => {
  it('merges duplicate requests and serializes different mailboxes', async () => {
    const first = deferred<string>()
    const calls: string[] = []
    const send = runLoginOtpRequest('one@example.test', async () => { calls.push('one'); return first.promise })
    const duplicate = runLoginOtpRequest('one@example.test', async () => { throw new Error('must not send') })
    const second = runLoginOtpRequest('two@example.test', async () => { calls.push('two'); return 'two' })
    expect(send).toBe(duplicate)
    expect(loginOtpRequestPending()).toBe(true)
    await Promise.resolve()
    expect(calls).toEqual(['one'])
    first.resolve('one')
    expect(await send).toBe('one')
    expect(await second).toBe('two')
    expect(calls).toEqual(['one', 'two'])
    expect(loginOtpRequestPending()).toBe(false)
  })

  it('captures Retry-After from only the matching OTP response without consuming it', async () => {
    await runLoginOtpRequest('one@example.test', async metadata => {
      const response = Response.json({ error_code: 'over_email_send_rate_limit' }, { status: 429, headers: { 'Retry-After': '29' } })
      const result = await observeLoginOtpFetch('https://auth.example.test/auth/v1/otp', { body: JSON.stringify({ email: 'one@example.test' }) }, async () => response)
      expect(metadata).toMatchObject({ status: 429, retryAfterSeconds: 29 })
      expect(await result.json()).toEqual({ error_code: 'over_email_send_rate_limit' })
    })
  })

  it('keeps other auth requests out of the current OTP attempt', async () => {
    await runLoginOtpRequest('one@example.test', async metadata => {
      await observeLoginOtpFetch('https://auth.example.test/auth/v1/token', { body: JSON.stringify({ email: 'one@example.test' }) }, async () => new Response('', { status: 500 }))
      await observeLoginOtpFetch('https://auth.example.test/auth/v1/otp', { body: JSON.stringify({ email: 'two@example.test' }) }, async () => new Response('', { status: 429 }))
      expect(metadata).toEqual({})
    })
  })

  it('preserves a timeout cause that the SDK would wrap as a generic fetch error', async () => {
    const timeout = new DOMException('Auth request timed out', 'TimeoutError')
    await runLoginOtpRequest('one@example.test', async metadata => {
      await expect(observeLoginOtpFetch('https://auth.example.test/auth/v1/otp', { body: JSON.stringify({ email: 'one@example.test' }) }, async () => { throw timeout })).rejects.toBe(timeout)
      expect(metadata.networkError).toBe(timeout)
    })
    await expect(runLoginOtpRequest('one@example.test', async () => 'recovered')).resolves.toBe('recovered')
  })

  it('accepts delta seconds and HTTP dates, rejecting malformed and past delays', () => {
    expect(retryAfterSeconds('1.2')).toBe(2)
    expect(retryAfterSeconds('Thu, 01 Jan 1970 00:00:30 GMT', 1_000)).toBe(29)
    for (const value of [null, '', '-1', 'garbage']) expect(retryAfterSeconds(value)).toBeUndefined()
    expect(retryAfterSeconds('Thu, 01 Jan 1970 00:00:00 GMT', 1_000)).toBeUndefined()
  })
})


it('retains the 15-second auth deadline and identifies generic abort errors as a send timeout', async () => {
  const { authBoundedFetch, AUTH_NETWORK_TIMEOUT_MS } = await import('../../../../apps/desktop/src/lib/authBoundedFetch')
  const controller = new AbortController()
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)
  vi.stubGlobal('fetch', async (_input: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => reject(new DOMException('The user aborted a request.', 'AbortError')), { once: true })
    controller.abort()
  }))
  try {
    await runLoginOtpRequest('one@example.test', async metadata => {
      await expect(authBoundedFetch('https://auth.example.test/auth/v1/otp', { body: JSON.stringify({ email: 'one@example.test' }) })).rejects.toMatchObject({ name: 'TimeoutError' })
      expect(metadata.networkError).toMatchObject({ name: 'TimeoutError' })
    })
    expect(AUTH_NETWORK_TIMEOUT_MS).toBe(15_000)
    expect(timeout).toHaveBeenCalledWith(15_000)
  } finally { timeout.mockRestore(); vi.unstubAllGlobals() }
})
