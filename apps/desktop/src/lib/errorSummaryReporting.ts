import { errorSummaryFromError } from '../../shared/error-summary'

const OPERATIONS = {
  'settings.read': 'apps/desktop/src/session/renderer/features/settings/app-settings-client.ts',
  'query.read': 'apps/desktop/src/session/renderer/lib/query-client.ts',
} as const

function report(error: unknown, type?: string, operation?: keyof typeof OPERATIONS): void {
  if (!window.electronAPI) return
  try {
    const summary = errorSummaryFromError(error, { version: 'unknown', system: 'unknown', time: new Date().toISOString() }, type)
    if (!summary) return
    if (operation) summary.locations = [OPERATIONS[operation]]
    window.electronAPI.eventSend('error-summary:report', summary)
  } catch { /* A reporting failure cannot create a second user error. */ }
}

export function reportHandledError(error: unknown, operation: keyof typeof OPERATIONS): void {
  // Only reviewed operation names may leave the boundary, never query keys/values.
  if (error instanceof DOMException && error.name === 'AbortError') return
  window.electronAPI?.eventSend('error-summary:encounter', null)
  report(error, 'HandledError', operation)
}

let installed = false
export function installErrorSummaryReporting(): void {
  if (!window.electronAPI || installed) return
  installed = true
  window.addEventListener('error', event => report(event.error))
  window.addEventListener('unhandledrejection', event => report(event.reason))
  window.addEventListener('gugu:react-error', event => report((event as CustomEvent<unknown>).detail, 'ReactRenderError'))
}
