/** Content-free local diagnostics. This allowlist is also enforced at the IPC boundary. */
export const LOCAL_DIAGNOSTICS_SCOPE = 'local-diagnostics'
export const MEMORY_SAMPLE_INTERVAL = 5 * 60_000
const EVENTS = ['start', 'long-task', 'memory', 'overlay-open', 'overlay-close', 'overlay-request', 'escape', 'suppressed'] as const
export type DiagnosticEvent = typeof EVENTS[number]
export type DiagnosticFields = Record<string, unknown> & { event: DiagnosticEvent }
const NUMBERS = ['at', 'eventAt', 'sequence', 'layerId', 'durationMs', 'captureDelayMs', 'observedAfterMs', 'usedHeapBytes', 'totalHeapBytes', 'heapLimitBytes', 'domElements', 'inertElements', 'observedRoots', 'detachedRoots', 'suppressed', 'longTasksSuppressed'] as const
const BOOLEANS = ['trusted', 'composing', 'defaultPrevented', 'bubbleReached', 'nextOpen', 'cancelled', 'longTaskSupported'] as const
const OWNERS = ['app-dialog', 'app-popover', 'session-dialog', 'session-popover', 'session-modal', 'unknown']
const DECISIONS = ['open-change-request', 'blocked-close-guard', 'close-requested', 'unknown']
const KINDS = ['dialog', 'alertdialog', 'popover', 'menu', 'sheet']

/** Keep source locations, never URL queries, frame names, titles, text, or arbitrary stack strings. */
export function diagnosticSource(value: unknown): string {
  if (typeof value !== 'string') return 'unknown'
  const text = value.slice(0, 512)
  if (/^(?:assets\/[A-Za-z0-9_.-]+\.[cm]?js|src\/[A-Za-z0-9_./-]+\.[cm]?[jt]sx?)(?::\d+:\d+)?$/.test(text)) return text
  const source = text.match(/(?:gugu-app:\/\/app|https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?)\/(assets\/[A-Za-z0-9_.-]+\.[cm]?js|src\/[A-Za-z0-9_./-]+\.[cm]?[jt]sx?)(?::(\d+):(\d+))?/)
  return source ? `${source[1]}${source[2] ? `:${source[2]}:${source[3]}` : ''}` : 'unknown'
}

export function diagnosticStack(stack: unknown): string[] {
  if (typeof stack !== 'string') return []
  return [...new Set(stack.slice(0, 4096).split('\n').map(diagnosticSource).filter(frame => frame !== 'unknown'))].slice(0, 6)
}

function layers(value: unknown): Array<{ id: number; kind: string; open?: boolean; connected?: boolean; inert?: boolean }> {
  if (!Array.isArray(value)) return []
  return value.slice(0, 16).flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const { id, kind } = item as Record<string, unknown>
    if (!Number.isSafeInteger(id) || Number(id) < 0 || !KINDS.includes(String(kind))) return []
    const out: { id: number; kind: string; open?: boolean; connected?: boolean; inert?: boolean } = { id: Number(id), kind: String(kind) }
    for (const key of ['open', 'connected', 'inert'] as const) if (typeof (item as Record<string, unknown>)[key] === 'boolean') out[key] = (item as Record<string, boolean>)[key]
    return [out]
  })
}

/** Reject unknown events; drop all fields not explicitly part of this metadata protocol. */
export function sanitizeDiagnosticFields(value: unknown): DiagnosticFields | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Record<string, unknown>
  if (!EVENTS.includes(input.event as DiagnosticEvent)) return null
  const out: DiagnosticFields = { event: input.event as DiagnosticEvent }
  for (const key of NUMBERS) {
    const n = input[key]
    if (typeof n === 'number' && Number.isFinite(n) && n >= 0) out[key] = Math.round(n * 100) / 100
  }
  for (const key of BOOLEANS) if (typeof input[key] === 'boolean') out[key] = input[key]
  if (typeof input.pageId === 'string' && /^[a-f0-9-]{36}$/.test(input.pageId)) out.pageId = input.pageId
  for (const key of ['before', 'after', 'layers'] as const) if (key in input) out[key] = layers(input[key])
  if (Array.isArray(input.handledBy)) out.handledBy = input.handledBy.filter(owner => OWNERS.includes(owner)).slice(0, 8)
  if (Array.isArray(input.decisions)) out.decisions = input.decisions.filter(decision => DECISIONS.includes(decision)).slice(0, 8)
  if (OWNERS.includes(String(input.owner))) out.owner = input.owner
  if (['INPUT', 'TEXTAREA', 'BUTTON', 'DIV', 'BODY', 'IFRAME', 'OTHER'].includes(String(input.focusTag))) out.focusTag = input.focusTag
  if (Array.isArray(input.callers)) out.callers = input.callers.map(diagnosticSource).filter(frame => frame !== 'unknown').slice(0, 6)
  if (Array.isArray(input.attribution)) out.attribution = input.attribution.slice(0, 4).map(item => {
    const entry = item && typeof item === 'object' ? item as Record<string, unknown> : {}
    return { source: diagnosticSource(entry.source), container: ['iframe', 'embed', 'object', 'window'].includes(String(entry.container)) ? entry.container : 'unknown' }
  })
  return out
}
