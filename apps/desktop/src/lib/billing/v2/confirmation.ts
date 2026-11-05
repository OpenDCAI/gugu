import { classifyCreditV2Error, CreditV2StateError } from './active'

/** Revision distinguishes an unread account from a failed read, including repeated failures. */
export type CreditConfirmation = {
  state: 'unconfirmed' | 'active2' | 'not-active' | 'contract-missing'
  revision: number
}

export function failedCreditConfirmation(error: unknown, revision: number): CreditConfirmation {
  // Presentation errors retain the structured domain error as their cause. Never parse translated text.
  const seen = new Set<unknown>()
  let current = error
  while (current && !seen.has(current)) {
    seen.add(current)
    const classified = classifyCreditV2Error(current)
    if (classified instanceof CreditV2StateError) {
      return { state: classified.state === 'not-active' ? 'not-active'
        : classified.state === 'account-changed' ? 'unconfirmed' : 'contract-missing', revision }
    }
    current = current instanceof Error ? current.cause : undefined
  }
  // Authentication/RLS/transport failures do not confirm a version; their actual error stays visible.
  return { state: 'unconfirmed', revision }
}
