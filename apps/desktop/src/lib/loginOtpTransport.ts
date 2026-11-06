/** Keep SDK OTP calls serial: they share the PKCE verifier with Google sign-in. */
export type LoginOtpMetadata = { status?: number; retryAfterSeconds?: number; networkError?: unknown }
type Flight = { email: string; result: Promise<unknown> }
const flights = new Map<string, Flight>()
const listeners = new Set<() => void>()
let tail: Promise<unknown> = Promise.resolve()
let current: { email: string; metadata: LoginOtpMetadata } | undefined

export const subscribeLoginOtpRequests = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
export const loginOtpRequestPending = () => flights.size > 0
function publish() { for (const listener of listeners) listener() }

export function runLoginOtpRequest<T>(email: string, work: (metadata: LoginOtpMetadata) => Promise<T>): Promise<T> {
  const existing = flights.get(email)
  if (existing) return existing.result as Promise<T>
  const result = tail.then(async () => {
    const metadata: LoginOtpMetadata = {}
    current = { email, metadata }
    try { return await work(metadata) }
    finally { current = undefined }
  }).finally(() => { flights.delete(email); publish() })
  flights.set(email, { email, result })
  tail = result.catch(() => undefined)
  publish()
  return result
}

export function retryAfterSeconds(value: string | null, now = Date.now()): number | undefined {
  if (!value?.trim()) return undefined
  const seconds = /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : (Date.parse(value) - now) / 1000
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds) : undefined
}

/** Observe only this SDK operation; return the original response and preserve PKCE. */
export async function observeLoginOtpFetch(input: RequestInfo | URL, init: RequestInit | undefined, send: () => Promise<Response>): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  let operation: typeof current
  if (current && new URL(url).pathname === '/auth/v1/otp' && typeof init?.body === 'string') {
    try { if ((JSON.parse(init.body) as { email?: string }).email === current.email) operation = current } catch { /* The SDK owns request validation. */ }
  }
  try {
    const response = await send()
    if (operation) {
      operation.metadata.status = response.status
      operation.metadata.retryAfterSeconds = retryAfterSeconds(response.headers.get('Retry-After'))
    }
    return response
  } catch (error) {
    if (operation) operation.metadata.networkError = error
    throw error
  }
}
