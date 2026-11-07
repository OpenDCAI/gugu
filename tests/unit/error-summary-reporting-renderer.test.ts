import { afterEach, expect, it, vi } from 'vitest'
import { SummaryErrorEvent } from './error-summary-event-fixture'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetModules() })

async function rig(initial: unknown) {
  let snapshot = initial
  let changed = () => {}
  const handlers = new Map<string, (event: unknown) => void>()
  const eventSend = vi.fn()
  const invoke = vi.fn(async () => snapshot)
  vi.stubGlobal('ErrorEvent', SummaryErrorEvent)
  vi.stubGlobal('window', {
    electronAPI: { invoke, eventSend, eventOn: (_channel: string, listener: () => void) => { changed = listener } },
    addEventListener: (kind: string, listener: (event: unknown) => void) => handlers.set(kind, listener),
  })
  const capture = vi.spyOn(await import('../../apps/desktop/shared/error-summary'), 'errorSummaryFromError')
  const extract = vi.spyOn(await import('../../apps/desktop/shared/error-summary-stack'), 'errorSummaryStackLocations')
  const module = await import('../../apps/desktop/src/lib/errorSummaryReporting')
  module.installErrorSummaryReporting()
  await Promise.resolve()
  const emitError = (error: unknown) => handlers.get('error')?.(new SummaryErrorEvent('error', { error, trusted: true }))
  return { module, capture, extract, eventSend, invoke, handlers, emitError, change: async (next: unknown) => { snapshot = next; changed(); await Promise.resolve() } }
}

it.each(['unknown', 'denied'])('does not read an error stack before %s consent is allowed', async decision => {
  const r = await rig({ eligible: true, context: 'anonymous', decision })
  r.emitError(new Error('private'))
  r.handlers.get('unhandledrejection')?.({ reason: new Error('private') })
  r.module.reportHandledError(new Error('private'), 'settings.read')
  await Promise.resolve()
  expect(r.capture).not.toHaveBeenCalled()
  expect(r.extract).not.toHaveBeenCalled()
  expect(r.eventSend.mock.calls.filter(call => call[0] === 'error-summary:report')).toEqual([])
  await r.change({ eligible: true, context: 'anonymous', decision: 'allowed' })
  expect(r.capture).not.toHaveBeenCalled()
  expect(r.extract).not.toHaveBeenCalled()
})

it('rechecks consent before capture and drops a late approval after withdrawal', async () => {
  const allowed = { eligible: true, context: 'anonymous', decision: 'allowed' }
  const r = await rig(allowed)
  let finish!: (snapshot: unknown) => void
  r.invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  r.emitError(new Error('private'))
  expect(r.capture).not.toHaveBeenCalled()
  await r.change({ ...allowed, decision: 'denied' })
  finish(allowed)
  await Promise.resolve()
  expect(r.capture).not.toHaveBeenCalled()
  expect(r.eventSend.mock.calls.filter(call => call[0] === 'error-summary:report')).toEqual([])
})

it('captures only a currently allowed context and never forwards another account', async () => {
  const r = await rig({ eligible: true, context: 'account-a', decision: 'allowed' })
  r.invoke.mockResolvedValueOnce({ eligible: true, context: 'account-b', decision: 'allowed' })
  r.emitError(new Error('private'))
  await Promise.resolve()
  expect(r.capture).not.toHaveBeenCalled()
  r.emitError(new TypeError('private'))
  await vi.waitFor(() => expect(r.capture).toHaveBeenCalledOnce())
  expect(r.eventSend).toHaveBeenCalledWith('error-summary:report', { context: 'account-a', summary: expect.objectContaining({ type: 'TypeError' }) })
})

it('does not touch a tampered error or DOMException name getter while denied', async () => {
  const r = await rig({ eligible: true, context: 'anonymous', decision: 'denied' })
  const getter = vi.fn(() => 'private')
  const error = new Error('private')
  Object.defineProperty(error, 'stack', { get: getter })
  const browserError = new DOMException('private', 'AbortError')
  Object.defineProperty(browserError, 'name', { get: getter })
  r.emitError(error)
  r.module.reportHandledError(browserError, 'settings.read')
  expect(getter).not.toHaveBeenCalled()
  expect(r.capture).not.toHaveBeenCalled()
})

it('does not call stack, name, or message accessors even after consent', async () => {
  const r = await rig({ eligible: true, context: 'anonymous', decision: 'allowed' })
  const getter = vi.fn(() => 'private')
  const error = new Error('private')
  for (const property of ['stack', 'name', 'message']) Object.defineProperty(error, property, { get: getter })
  r.emitError(error)
  await vi.waitFor(() => expect(r.capture).toHaveBeenCalledOnce())
  expect(getter).not.toHaveBeenCalled()
  expect(r.eventSend).toHaveBeenCalledWith('error-summary:report', { context: 'anonymous', summary: expect.objectContaining({ type: 'Error', locations: [] }) })
})

it('fails closed if the current consent lookup fails', async () => {
  const r = await rig({ eligible: true, context: 'anonymous', decision: 'allowed' })
  r.invoke.mockRejectedValueOnce(new Error('consent unavailable'))
  r.emitError(new Error('private'))
  await Promise.resolve()
  expect(r.capture).not.toHaveBeenCalled()
  expect(r.eventSend).not.toHaveBeenCalled()
})

it('uses the browser throw point for an allowed error already formatted by local logging', async () => {
  const r = await rig({ eligible: true, context: 'anonymous', decision: 'allowed' })
  const error = new Error('private\n    at apps/desktop/src/accounts/alice/account-1234.ts:12:3')
  void error.stack
  r.handlers.get('error')?.(new SummaryErrorEvent('error', { error, trusted: true, filename: 'gugu-app://app/assets/main-abcd.js', lineno: 12, colno: 3 }))
  await vi.waitFor(() => expect(r.capture).toHaveBeenCalledOnce())
  expect(r.extract).not.toHaveBeenCalled()
  expect(r.eventSend).toHaveBeenCalledWith('error-summary:report', { context: 'anonymous', summary: expect.objectContaining({ locations: ['dist/assets/main-abcd.js:12:3'] }) })
  expect(JSON.stringify(r.eventSend.mock.calls)).not.toMatch(/alice|account-1234|private/)
})
