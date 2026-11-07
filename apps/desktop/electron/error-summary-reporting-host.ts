import { anySignal } from '@gugu/core/shared/anySignal'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app, ipcMain, BrowserWindow } from 'electron'
import { createErrorSummaryReporter } from '../shared/error-summary-reporter'
import { errorSummaryFromError, sanitizeErrorSummary } from '../shared/error-summary'
import { errorSummaryStackLocations } from '../shared/error-summary-stack'
import { errorSummaryDestination, errorSummaryRequest } from '../shared/error-summary-transport'

declare const __GUGU_ERROR_REPORTING_ENDPOINT__: string | undefined

export function registerErrorSummaryReporting(deps: {
  eligible: boolean
  owner: () => string | null | undefined
}) {
  const destination = errorSummaryDestination(typeof __GUGU_ERROR_REPORTING_ENDPOINT__ === 'string' ? __GUGU_ERROR_REPORTING_ENDPOINT__ : '')
  // No endpoint means no queue reads/writes, hooks, timers or reporting requests.
  if (!deps.eligible || !destination) return
  const file = join(app.getPath('userData'), 'pending-error-summaries.json')
  const context = () => {
    let allowed = false
    ipcMain.emit('error-summary:read-local-consent', (snapshot: unknown) => {
      if (snapshot && typeof snapshot === 'object') {
        const value = snapshot as { eligible?: unknown; decision?: unknown }
        allowed = value.eligible === true && value.decision === 'allowed'
      }
    })
    const owner = deps.owner()
    return { eligible: deps.eligible, allowed, scope: owner === undefined ? undefined : owner === null ? 'anonymous' : createHash('sha256').update(owner).digest('hex') }
  }
  const reporter = createErrorSummaryReporter({
    configured: true,
    context,
    now: Date.now,
    read: () => {
      try { return JSON.parse(readFileSync(file, 'utf8')) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
      }
    },
    save: pending => {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(`${file}.tmp`, JSON.stringify(pending), { mode: 0o600 })
      renameSync(`${file}.tmp`, file)
    },
    send: async (summary, signal) => {
      // A private connection: never use the signed-in Chromium session/cookie jar.
      const body = errorSummaryRequest(summary)
      if (!body) return
      const response = await fetch(destination.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'gugu-error-summary/1' },
        body,
        signal: anySignal([signal, AbortSignal.timeout(5_000)]),
        redirect: 'error',
        credentials: 'omit',
      })
      if (!response.ok) throw new Error('Error summary receiver rejected event')
      await response.body?.cancel()
    },
  })
  const safely = (action: () => void) => { try { action() } catch { /* No recursive error-reporting failures. */ } }
  const metadata = () => ({ version: app.getVersion(), system: process.platform, time: new Date().toISOString() })
  const captureScope = () => {
    const current = context()
    return current.eligible && current.allowed ? current.scope : undefined
  }
  const reportError = (error: unknown, type?: string) => safely(() => {
    if (captureScope() === undefined) return
    reporter.report(errorSummaryFromError(error, metadata(), type, errorSummaryStackLocations(error)))
  })
  let initialized = false
  let previousOwner = deps.owner()
  ipcMain.on('error-summary:consent-changed', () => safely(() => {
    const owner = deps.owner()
    if (owner === undefined) return
    if (!initialized) { initialized = true; previousOwner = owner; reporter.start(); return }
    if (owner !== previousOwner || !context().allowed) reporter.changed()
    previousOwner = owner
  }))
  ipcMain.on('error-summary:report', (event, candidate: unknown) => {
    if (!BrowserWindow.fromWebContents(event.sender)) return
    safely(() => {
      const scope = captureScope()
      if (scope === undefined || !candidate || typeof candidate !== 'object') return
      // A renderer approval may have become stale before this IPC was received.
      if (Object.getOwnPropertyDescriptor(candidate, 'context')?.value !== scope) return
      const summary = sanitizeErrorSummary(Object.getOwnPropertyDescriptor(candidate, 'summary')?.value)
      // The main process supplies trusted version, OS and time, not the sender.
      if (summary) reporter.report({ ...summary, ...metadata() })
    })
  })
  // Read before ordinary fatal/rejection loggers format and cache the raw stack.
  process.prependListener('uncaughtExceptionMonitor', error => reportError(error))
  process.prependListener('unhandledRejection', error => reportError(error))
  app.on('render-process-gone', (_event, _contents, details) => {
    if (details.reason !== 'clean-exit') reportError(null, 'RendererProcessGone')
  })
  if (context().scope !== undefined) safely(() => { initialized = true; reporter.start() })
  // No hot retries: retry only on restart or another reportable occurrence.
}
