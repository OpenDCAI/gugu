import { useEffect, useState } from 'react'
import { getReferralStats, type ReferralStats } from '../../lib/billing'
import { readDisplayIdentities } from '../../lib/identityReadAdapter'
import { rendererLogger } from '../../lib/log'
import { buildReferralShareUrl } from '../../lib/referral'
import type { AuthUser } from '../../store/auth'

type FailedPart = 'number' | 'stats'
type State = { owner: string | null; number: number | null; referral: ReferralStats | null; pending: boolean; failed: FailedPart[] }

/** Invitation identity and stats share one error outlet; results never cross account boundaries. */
export function useReferralCardData(user: AuthUser | null, authLoading: boolean) {
  const owner = user?.id ?? null
  const knownNumber = user?.gugu_number ?? null
  const identityPending = user?.identityPending === true
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<State>({ owner, number: knownNumber, referral: null, pending: true, failed: [] })
  useEffect(() => {
    if (!owner || authLoading || identityPending) return
    let active = true
    const controller = new AbortController()
    setState(previous => ({ owner, number: knownNumber ?? (previous.owner === owner ? previous.number : null), referral: previous.owner === owner ? previous.referral : null, pending: true, failed: [] }))
    const number = knownNumber ? Promise.resolve(knownNumber) : readDisplayIdentities([owner], controller.signal).then(rows => {
      const value = rows.find(row => row.id === owner)?.gugu_number
      if (!value || !Number.isFinite(value) || value <= 0) throw new Error('Invitation identity number was not returned')
      return value
    })
    void Promise.allSettled([number, getReferralStats()]).then(([numberResult, statsResult]) => {
      if (!active) return
      const failed: FailedPart[] = []
      if (numberResult.status === 'rejected') { failed.push('number'); rendererLogger('referral').warn({ error: numberResult.reason }, 'invitation number read failed') }
      if (statsResult.status === 'rejected') { failed.push('stats'); rendererLogger('referral').warn({ error: statsResult.reason }, 'invitation stats read failed') }
      setState({ owner, number: numberResult.status === 'fulfilled' ? numberResult.value : null, referral: statsResult.status === 'fulfilled' ? statsResult.value : null, pending: false, failed })
    })
    return () => { active = false; controller.abort() }
  }, [owner, knownNumber, identityPending, authLoading, attempt])
  const current = state.owner === owner ? state : { owner, number: knownNumber, referral: null, pending: true, failed: [] }
  return { ...current, inviteUrl: buildReferralShareUrl(knownNumber ?? current.number), retry: () => setAttempt(value => value + 1) }
}
