import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { runInThisContext } from 'node:vm'
import { app, ipcMain } from 'electron'
import { registerErrorSummaryReporting } from '../../apps/desktop/electron/error-summary-reporting-host'
import * as normalization from '../../apps/desktop/shared/error-summary'
import * as stack from '../../apps/desktop/shared/error-summary-stack'

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
  vi.restoreAllMocks()
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
    ipcMain.emit('error-summary:report', { sender: { trusted: true } }, { context: 'anonymous', summary: candidate })
    expect(fetch).not.toHaveBeenCalled()
    ipcMain.on('error-summary:read-local-consent', (reply: unknown) => { if (typeof reply === 'function') reply({ eligible: true, decision: 'allowed' }) })
    ipcMain.emit('error-summary:report', { sender: { trusted: false } }, { context: 'anonymous', summary: candidate })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('builds outgoing protocol data from the allowlist and supplies trusted host metadata', async () => {
    ipcMain.on('error-summary:read-local-consent', (reply: unknown) => { if (typeof reply === 'function') reply({ eligible: true, decision: 'allowed' }) })
    registerErrorSummaryReporting({ eligible: true, owner: () => 'test-owner-only-local' })
    const context = createHash('sha256').update('test-owner-only-local').digest('hex')
    ipcMain.emit('error-summary:report', { sender: { trusted: true } }, { context, summary: { ...candidate, version: 'someone@example.test', system: 'private OS' } })
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

  it.each(['unknown', 'denied'])('does not extract native errors or IPC data before %s consent', decision => {
    ipcMain.on('error-summary:read-local-consent', (reply: unknown) => { if (typeof reply === 'function') reply({ eligible: true, decision }) })
    registerErrorSummaryReporting({ eligible: true, owner: () => null })
    const capture = vi.spyOn(normalization, 'errorSummaryFromError')
    const extract = vi.spyOn(stack, 'errorSummaryStackLocations')
    const sanitize = vi.spyOn(normalization, 'sanitizeErrorSummary')
    const getter = vi.fn(() => 'private')
    const error = new Error('private')
    Object.defineProperty(error, 'stack', { get: getter })
    process.listeners('uncaughtExceptionMonitor').find(listener => !previousExceptionListeners.includes(listener))!(error, 'uncaughtException')
    process.listeners('unhandledRejection').find(listener => !previousRejectionListeners.includes(listener))!(error, Promise.resolve())
    ipcMain.emit('error-summary:report', { sender: { trusted: true } }, { context: 'anonymous', summary: candidate })
    expect(capture).not.toHaveBeenCalled()
    expect(extract).not.toHaveBeenCalled()
    expect(sanitize).not.toHaveBeenCalled()
    expect(getter).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('reports an allowed native error category without formatting any error accessors', async () => {
    ipcMain.on('error-summary:read-local-consent', (reply: unknown) => { if (typeof reply === 'function') reply({ eligible: true, decision: 'allowed' }) })
    registerErrorSummaryReporting({ eligible: true, owner: () => null })
    const getter = vi.fn(() => 'private')
    const error = new TypeError('private')
    for (const property of ['stack', 'name', 'message']) Object.defineProperty(error, property, { get: getter })
    process.listeners('uncaughtExceptionMonitor').find(listener => !previousExceptionListeners.includes(listener))!(error, 'uncaughtException')
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    expect(getter).not.toHaveBeenCalled()
    const body = String(vi.mocked(fetch).mock.calls[0][1]!.body)
    expect(JSON.parse(body).summary).toMatchObject({ type: 'TypeError', locations: [] })
    expect(body).not.toContain('private')
  })

  it('prepends native capture before an existing logger and keeps the actual throw frame', async () => {
    const log = (error: Error) => { void error.stack }
    process.on('uncaughtExceptionMonitor', log)
    ipcMain.on('error-summary:read-local-consent', (reply: unknown) => { if (typeof reply === 'function') reply({ eligible: true, decision: 'allowed' }) })
    registerErrorSummaryReporting({ eligible: true, owner: () => null })
    const throwError = runInThisContext('(function throwSite(ErrorType){throw new ErrorType("private")})', { filename: 'apps/desktop/electron/summary-throw.js' }) as (constructor: typeof Error) => never
    let error!: Error
    try { throwError(Error) } catch (caught) { error = caught as Error }
    const handlers = process.listeners('uncaughtExceptionMonitor').filter(listener => !previousExceptionListeners.includes(listener))
    expect(handlers[0]).not.toBe(log)
    for (const listener of handlers) listener(error, 'uncaughtException')
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]!.body))
    expect(body.summary.locations[0]).toBe('apps/desktop/electron/summary-throw.js:1:38')
  })

  it('rejects a renderer report whose allowed account changed before IPC delivery', () => {
    ipcMain.on('error-summary:read-local-consent', (reply: unknown) => { if (typeof reply === 'function') reply({ eligible: true, decision: 'allowed' }) })
    registerErrorSummaryReporting({ eligible: true, owner: () => 'account-b' })
    const sanitize = vi.spyOn(normalization, 'sanitizeErrorSummary')
    const context = createHash('sha256').update('account-a').digest('hex')
    ipcMain.emit('error-summary:report', { sender: { trusted: true } }, { context, summary: candidate })
    expect(sanitize).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })
})
