import { useSyncExternalStore } from 'react'
import { ERROR_SUMMARY_CONSENT_CHANNELS as channels, type ErrorSummaryConsentSnapshot, type ErrorSummaryDecision } from '../../shared/error-summary-consent'
import { sessionCoordinator } from './sessionCoordinator'

const unavailable: ErrorSummaryConsentSnapshot = { eligible: false, context: null, decision: 'unknown', encountered: false }
let current = unavailable
let owner: string | null | undefined
let generation = 0
let installed = false
const listeners = new Set<() => void>()
const publish = (next: ErrorSummaryConsentSnapshot) => { current = next; for (const listener of listeners) listener() }

async function refresh(): Promise<void> {
  const token = ++generation
  try {
    const next = await window.electronAPI?.invoke(channels.read) as ErrorSummaryConsentSnapshot | undefined
    if (token === generation) publish(next ?? unavailable)
  } catch { if (token === generation) publish(unavailable) }
}

export function installErrorSummaryConsent(): void {
  if (!window.electronAPI || installed) return
  installed = true
  window.electronAPI.eventOn(channels.changed, () => { void refresh() })
  sessionCoordinator.subscribe(() => {
    const session = sessionCoordinator.getSnapshot()
    const nextOwner = session.status === 'boot-restoring' ? undefined : session.user?.id ?? null
    if (nextOwner === owner) return
    owner = nextOwner
    generation++
    publish(unavailable)
    void refresh()
  })
  void refresh()
}

export async function setErrorSummaryConsent(decision: Exclude<ErrorSummaryDecision, 'unknown'>): Promise<void> {
  const token = ++generation
  const next = await window.electronAPI?.invoke(channels.write, decision, current.context) as ErrorSummaryConsentSnapshot
  if (token === generation) publish(next)
}

export function useErrorSummaryConsent(): ErrorSummaryConsentSnapshot {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener) }, () => current, () => unavailable)
}
