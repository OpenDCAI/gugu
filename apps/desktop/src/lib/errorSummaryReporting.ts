import { errorSummaryFromError } from '../../shared/error-summary'
import { errorSummaryStackLocations } from '../../shared/error-summary-stack'
import { createErrorSummaryErrorEventReader } from './errorSummaryErrorEvent'

const OPERATIONS = {
  'settings.read': 'apps/desktop/src/session/renderer/features/settings/app-settings-client.ts',
  'query.read': 'apps/desktop/src/session/renderer/lib/query-client.ts',
} as const

let context: string | null = null
let generation = 0
let checking = false

function allowedContext(snapshot: unknown): string | null {
  if (!snapshot || typeof snapshot !== 'object') return null
  const own = (key: string): unknown => Object.getOwnPropertyDescriptor(snapshot, key)?.value
  const scope = own('context')
  return own('eligible') === true && own('decision') === 'allowed' && typeof scope === 'string' ? scope : null
}

async function refreshConsent(): Promise<void> {
  const token = ++generation
  context = null
  try {
    const next = allowedContext(await window.electronAPI?.invoke('error-summary:consent-read'))
    if (token === generation) context = next
  } catch { /* Missing/unavailable consent host means collection stays disabled. */ }
}

async function report(read: () => { error: unknown; locations?: string[] } | null, type?: string): Promise<void> {
  const api = window.electronAPI
  // Drop pre-consent errors immediately. Never retain them until a later approval.
  if (!api || context === null || checking) return
  const expected = context
  const token = generation
  checking = true
  try {
    const fresh = allowedContext(await api.invoke('error-summary:consent-read'))
    if (token !== generation || context !== expected || fresh !== expected) return
    const input = read()
    if (!input) return
    const locations = input.locations?.length ? input.locations : errorSummaryStackLocations(input.error)
    const summary = errorSummaryFromError(input.error, { version: 'unknown', system: 'unknown', time: new Date().toISOString() }, type, locations)
    if (!summary) return
    // Context is local IPC only; the host checks it again and never transmits it.
    api.eventSend('error-summary:report', { context: expected, summary })
  } catch { /* A reporting failure cannot create a second user error. */ } finally { checking = false }
}

export function reportHandledError(error: unknown, operation: keyof typeof OPERATIONS): void {
  // Only reviewed operation names may leave the boundary, never query keys/values.
  // Browser control-flow exceptions are excluded without calling their name getter.
  if (error instanceof DOMException) return
  window.electronAPI?.eventSend('error-summary:encounter', null)
  void report(() => ({ error, locations: [OPERATIONS[operation]] }), 'HandledError')
}

let installed = false
export function installErrorSummaryReporting(): void {
  if (!window.electronAPI || installed) return
  installed = true
  window.electronAPI.eventOn('error-summary:consent-changed', () => { void refreshConsent() })
  void refreshConsent()
  const readErrorEvent = createErrorSummaryErrorEventReader()
  window.addEventListener('error', event => { void report(() => readErrorEvent(event)) })
  window.addEventListener('unhandledrejection', event => { void report(() => ({ error: event.reason })) })
  window.addEventListener('gugu:react-error', event => { void report(() => ({ error: (event as CustomEvent<unknown>).detail }), 'ReactRenderError') })
}
