import { afterEach, expect, it, vi } from 'vitest'
import { ERROR_SUMMARY_CONSENT_CHANNELS as channels, type ErrorSummaryConsentSnapshot } from '../../apps/desktop/shared/error-summary-consent'

vi.mock('../../apps/desktop/src/lib/sessionCoordinator', () => ({
  sessionCoordinator: { subscribe: vi.fn(), getSnapshot: () => ({ status: 'signed-out', user: null }) },
}))

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

it('binds a choice to the context rendered in the UI and rejects a stale account choice', async () => {
  let snapshot: ErrorSummaryConsentSnapshot = { eligible: true, context: 'anonymous', decision: 'unknown', encountered: true }
  let changed = () => {}
  const invoke = vi.fn(async (channel: string, decision?: string, context?: string) => {
    if (channel === channels.write) {
      if (context !== snapshot.context || (decision !== 'allowed' && decision !== 'denied')) throw new Error('Unavailable context')
      snapshot = { ...snapshot, decision }
    }
    return snapshot
  })
  vi.stubGlobal('window', { electronAPI: { invoke, eventOn: (_channel: string, callback: () => void) => { changed = callback } } })
  const consent = await import('../../apps/desktop/src/lib/errorSummaryConsent')
  consent.installErrorSummaryConsent()
  await Promise.resolve()
  await consent.setErrorSummaryConsent('allowed', 'anonymous')
  expect(invoke).toHaveBeenLastCalledWith(channels.write, 'allowed', 'anonymous')

  snapshot = { ...snapshot, context: 'a'.repeat(64), decision: 'unknown' }
  changed()
  await Promise.resolve()
  await expect(consent.setErrorSummaryConsent('allowed', 'anonymous')).rejects.toThrow('context changed')
  expect(invoke.mock.calls.filter(call => call[0] === channels.write)).toHaveLength(1)
  await consent.setErrorSummaryConsent('denied', snapshot.context)
  expect(invoke).toHaveBeenLastCalledWith(channels.write, 'denied', snapshot.context)
})
