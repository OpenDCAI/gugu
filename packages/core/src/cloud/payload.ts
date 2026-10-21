// Shared helpers for normalizing Supabase Realtime broadcast payloads.
// Supabase wraps app payloads under `.payload` on broadcast; we accept both
// shapes (nested or flat) so producers can send either.

export function unwrapPayload(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object') return {}
  const outer = payload as Record<string, unknown>
  const inner = outer.payload
  return inner && typeof inner === 'object' ? (inner as Record<string, unknown>) : outer
}

export function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function nullableText(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

export function nullableTextArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  return value.every((item) => typeof item === 'string') ? value : null
}

export function numberOrSentinel(value: unknown, sentinel: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : sentinel
}
