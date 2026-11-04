/** Existing transient connection classification shared by device initialization and file reads. */
export function transientNetworkErrorCode(err: unknown): string | null {
  const direct = (err as { code?: unknown } | null | undefined)?.code
  if (typeof direct === 'string' && direct) return direct
  const cause = (err as { cause?: { code?: unknown } } | null | undefined)?.cause
  return typeof cause?.code === 'string' && cause.code ? cause.code : null
}

export function isTransientNetworkError(err: unknown): boolean {
  const code = transientNetworkErrorCode(err)
  if (code && /^(?:EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ECONNRESET|ECONNREFUSED|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT)$/i.test(code)) return true
  const message = err instanceof Error ? err.message : String(err ?? '')
  return /\bfetch failed\b|\bnetwork error\b|\bsocket hang up\b|\bconnection (?:reset|refused|timed out)\b/i.test(message)
}
