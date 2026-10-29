/**
 * Protocol 13 can still submit the removed credential form. Only recognize its request ID;
 * discard credential fields and immediately settle the old UI. Retire with the startup
 * migration in lib/remove-legacy-browser-logins.ts when protocol 13 leaves the supported window.
 * A released protocol-13 UI renders reason=gone; it does not display the message field.
 */
export function removedVaultRequest(raw: string): { requestId: string } | null {
  let value: unknown
  try { value = JSON.parse(raw) } catch { return null }
  if (!value || typeof value !== 'object') return null
  const request = value as { type?: unknown; requestId?: unknown }
  return request.type === 'vault_submit' && typeof request.requestId === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(request.requestId)
    ? { requestId: request.requestId }
    : null
}
