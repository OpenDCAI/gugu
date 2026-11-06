export type ErrorSummaryDecision = 'unknown' | 'allowed' | 'denied'
export interface ErrorSummaryConsentSnapshot {
  eligible: boolean
  context: string | null
  decision: ErrorSummaryDecision
  encountered: boolean
}

export const ERROR_SUMMARY_CONSENT_CHANNELS = {
  read: 'error-summary:consent-read',
  write: 'error-summary:consent-write',
  encounter: 'error-summary:encounter',
  changed: 'error-summary:consent-changed',
} as const

/** This file is a local installation contract, never an outgoing event. */
export interface ErrorSummaryConsentRecord {
  version: 1
  decisions: Record<string, 'allowed' | 'denied'>
  encountered: Record<string, true>
}

export function decodeErrorSummaryConsent(value: unknown): ErrorSummaryConsentRecord {
  const out: ErrorSummaryConsentRecord = { version: 1, decisions: {}, encountered: {} }
  if (!value || typeof value !== 'object') return out
  const record = value as Partial<ErrorSummaryConsentRecord>
  if (record.version !== 1) return out
  if (record.decisions && typeof record.decisions === 'object') {
    for (const [key, decision] of Object.entries(record.decisions)) {
      if (/^(?:anonymous|[a-f0-9]{64})$/.test(key) && (decision === 'allowed' || decision === 'denied')) out.decisions[key] = decision
    }
  }
  if (record.encountered && typeof record.encountered === 'object') {
    for (const [key, seen] of Object.entries(record.encountered)) {
      if (/^(?:startup|anonymous|[a-f0-9]{64})$/.test(key) && seen === true) out.encountered[key] = true
    }
  }
  return out
}

export function createErrorSummaryConsentStore(deps: {
  eligible: boolean
  read: () => unknown
  save: (record: ErrorSummaryConsentRecord) => void
  scope: () => string | undefined
  changed: () => void
  withdraw: () => void
}) {
  // Read failures disable reporting. An explicit retry can still save a new choice.
  let record: ErrorSummaryConsentRecord
  try { record = decodeErrorSummaryConsent(deps.read()) } catch { record = decodeErrorSummaryConsent(null) }
  const blocked = new Set<string>()
  const snapshot = (): ErrorSummaryConsentSnapshot => {
    const scope = deps.scope()
    return {
      eligible: deps.eligible && scope !== undefined,
      context: scope ?? null,
      decision: scope === undefined || blocked.has(scope) ? 'unknown' : record.decisions[scope] ?? 'unknown',
      encountered: scope !== undefined && (record.encountered[scope] === true || record.encountered.startup === true),
    }
  }
  const encounter = () => {
    if (!deps.eligible) return
    const scope = deps.scope() ?? 'startup'
    if (record.decisions[scope] || record.encountered[scope]) return
    record.encountered[scope] = true
    try { deps.save(record) } finally { deps.changed() }
  }
  return {
    snapshot,
    encounter,
    block() {
      const scope = deps.scope()
      if (scope !== undefined) blocked.add(scope)
      deps.changed()
    },
    set(decision: unknown, expectedScope: unknown = deps.scope()) {
      const scope = deps.scope()
      if (!deps.eligible || scope === undefined || expectedScope !== scope || (decision !== 'allowed' && decision !== 'denied')) throw new Error('Error summary consent is unavailable')
      // Revoke in memory before disk I/O, including a failed withdrawal.
      if (decision === 'denied') { blocked.add(scope); deps.changed(); deps.withdraw() }
      const next: ErrorSummaryConsentRecord = {
        version: 1,
        decisions: { ...record.decisions, [scope]: decision },
        encountered: { ...record.encountered },
      }
      delete next.encountered[scope]
      delete next.encountered.startup
      deps.save(next)
      record = next
      blocked.delete(scope)
      deps.changed()
      return snapshot()
    },
  }
}
