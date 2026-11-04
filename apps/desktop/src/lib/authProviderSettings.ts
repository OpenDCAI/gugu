export const AUTH_SETTINGS_TIMEOUT_MS = 2_000

/** Public backend capabilities only. Fail closed within the whole fetch/body deadline;
 * this never reads or writes a user session, or changes provider configuration. */
export function readGoogleProviderEnabled(url: string, anonKey: string,
  request: typeof fetch = globalThis.fetch.bind(globalThis), signal?: AbortSignal): Promise<boolean> {
  return new Promise(resolve => {
    const controller = new AbortController()
    let settled = false
    const finish = (enabled: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancelled)
      controller.abort()
      resolve(enabled)
    }
    const cancelled = () => finish(false)
    const timer = setTimeout(cancelled, AUTH_SETTINGS_TIMEOUT_MS)
    signal?.addEventListener('abort', cancelled, { once: true })
    if (signal?.aborted) { finish(false); return }
    void (async () => {
      try {
        const response = await request(`${url.replace(/\/+$/, '')}/auth/v1/settings`, {
          headers: { apikey: anonKey, Accept: 'application/json' }, cache: 'no-store', signal: controller.signal,
        })
        if (!response.ok) { finish(false); return }
        const data: unknown = await response.json()
        const external = data && typeof data === 'object' ? (data as { external?: unknown }).external : null
        finish(Boolean(external && typeof external === 'object' && (external as { google?: unknown }).google === true))
      } catch { finish(false) }
    })()
  })
}
