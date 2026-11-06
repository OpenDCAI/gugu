import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, ipcMain } from 'electron'
import { registerErrorSummaryReporting } from '../../apps/desktop/electron/error-summary-reporting-host'

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    app: Object.assign(new EventEmitter(), { getPath: vi.fn(), getVersion: () => '0.3.2' }),
    ipcMain: new EventEmitter(),
    BrowserWindow: { fromWebContents: (sender: { trusted?: boolean }) => sender?.trusted ? {} : null },
  }
})

let root: string
let previousExceptionListeners: NodeJS.UncaughtExceptionListener[]
let previousRejectionListeners: NodeJS.UnhandledRejectionListener[]
const candidate = { type: 'TypeError', locations: ['apps/desktop/src/App.tsx:12:3'], version: '0.3.2', system: 'darwin', time: '2026-11-06T15:00:00.000Z', message: 'private user content', user: { email: 'someone@example.test' } }

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gugu-summary-host-'))
  vi.mocked(app.getPath).mockReturnValue(root)
  previousExceptionListeners = process.listeners('uncaughtExceptionMonitor')
  previousRejectionListeners = process.listeners('unhandledRejection')
  vi.stubGlobal('__GUGU_ERROR_REPORTING_ENDPOINT__', 'https://errors.example.test/v1/beta-errors')
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, body: null })))
})

afterEach(() => {
  for (const listener of process.listeners('uncaughtExceptionMonitor')) if (!previousExceptionListeners.includes(listener)) process.removeListener('uncaughtExceptionMonitor', listener)
  for (const listener of process.listeners('unhandledRejection')) if (!previousRejectionListeners.includes(listener)) process.removeListener('unhandledRejection', listener)
  app.removeAllListeners()
  ipcMain.removeAllListeners()
  vi.unstubAllGlobals()
  rmSync(root, { recursive: true, force: true })
})

describe('native summary reporting boundary', () => {
  it('does not install collectors or touch pending storage for an empty endpoint or nonpilot build', () => {
    vi.stubGlobal('__GUGU_ERROR_REPORTING_ENDPOINT__', '')
    registerErrorSummaryReporting({ eligible: true, owner: () => null })
    vi.stubGlobal('__GUGU_ERROR_REPORTING_ENDPOINT__', 'https://errors.example.test/v1/beta-errors')
    registerErrorSummaryReporting({ eligible: false, owner: () => null })
    expect(process.listeners('uncaughtExceptionMonitor')).toEqual(previousExceptionListeners)
    expect(ipcMain.listenerCount('error-summary:report')).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
    expect(() => readFileSync(join(root, 'pending-error-summaries.json'))).toThrow()
  })

  it('requires the independent consent owner and a trusted application window', () => {
    registerErrorSummaryReporting({ eligible: true, owner: () => null })
    ipcMain.emit('error-summary:report', { sender: { trusted: true } }, candidate)
    expect(fetch).not.toHaveBeenCalled()
    ipcMain.on('error-summary:read-local-consent', reply => reply({ eligible: true, decision: 'allowed' }))
    ipcMain.emit('error-summary:report', { sender: { trusted: false } }, candidate)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('builds outgoing protocol data from the allowlist and supplies trusted host metadata', async () => {
    ipcMain.on('error-summary:read-local-consent', reply => reply({ eligible: true, decision: 'allowed' }))
    registerErrorSummaryReporting({ eligible: true, owner: () => 'test-owner-only-local' })
    ipcMain.emit('error-summary:report', { sender: { trusted: true } }, { ...candidate, version: 'someone@example.test', system: 'private OS' })
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    const [url, options] = vi.mocked(fetch).mock.calls[0]
    expect(url).toBe('https://errors.example.test/v1/beta-errors')
    const request = JSON.parse(String(options!.body))
    expect(Object.keys(request).sort()).toEqual(['schemaVersion', 'summary'])
    expect(request.schemaVersion).toBe(1)
    const event = request.summary
    expect(event.version).toBe('0.3.2')
    expect(event.system).toBe(process.platform)
    expect(event.time).not.toBe(candidate.time)
    expect(String(options!.body)).not.toMatch(/private|someone|test-owner/)
    expect(options!.redirect).toBe('error')
    expect(options!.credentials).toBe('omit')
  })
})
