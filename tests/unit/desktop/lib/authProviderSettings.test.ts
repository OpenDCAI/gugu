import { afterEach, expect, it, vi } from 'vitest'
import { AUTH_SETTINGS_TIMEOUT_MS, readGoogleProviderEnabled } from '../../../../apps/desktop/src/lib/authProviderSettings'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

it.each([
  [{ external: { google: true } }, true], [{ external: { google: false } }, false],
  [{}, false], [{ external: { google: 'true' } }, false], [null, false],
])('reads only explicit Google=true from backend settings: %j', async (body, enabled) => {
  const request: typeof fetch = async (url, init) => {
    expect(url).toBe('https://auth.example.test/auth/v1/settings')
    expect(new Headers(init?.headers).get('apikey')).toBe('public-test-key')
    expect(init?.cache).toBe('no-store')
    return Response.json(body)
  }
  expect(await readGoogleProviderEnabled('https://auth.example.test/', 'public-test-key', request)).toBe(enabled)
})

it('falls back to email on an HTTP error, invalid JSON or rejected network request', async () => {
  for (const request of [
    async () => Response.json({ external: { google: true } }, { status: 503 }),
    async () => new Response('{'), async () => { throw new TypeError('offline') },
  ]) expect(await readGoogleProviderEnabled('https://auth.example.test', 'key', request)).toBe(false)
})

it.each([false, true])('limits the complete settings fetch/body to 2s (body wait=%s)', async bodyWait => {
  vi.useFakeTimers()
  let release!: (response: Response) => void
  const pending = new Promise<Response>(resolve => { release = resolve })
  let signal: AbortSignal | null | undefined
  const request: typeof fetch = async (_url, init) => {
    signal = init?.signal
    return bodyWait ? new Response(new ReadableStream({ start() {} })) : pending
  }
  const result = readGoogleProviderEnabled('https://auth.example.test', 'key', request)
  await vi.advanceTimersByTimeAsync(AUTH_SETTINGS_TIMEOUT_MS)
  expect(await result).toBe(false)
  expect(signal?.aborted).toBe(true)
  release(Response.json({ external: { google: true } }))
  expect(await result).toBe(false)
})

it('binds the host receiver on the default fetch path', async () => {
  vi.stubGlobal('fetch', function (this: unknown) {
    expect(this).toBe(globalThis)
    return Promise.resolve(Response.json({ external: { google: true } }))
  })
  expect(await readGoogleProviderEnabled('https://auth.example.test', 'key')).toBe(true)
})

it('cancels settings immediately on unmount without waiting for timeout', async () => {
  const controller = new AbortController()
  const result = readGoogleProviderEnabled('https://auth.example.test', 'key', async () => new Promise(() => {}), controller.signal)
  controller.abort()
  expect(await result).toBe(false)
})
