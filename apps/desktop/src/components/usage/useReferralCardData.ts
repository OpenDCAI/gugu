import { useEffect, useReducer, useState } from 'react'
import { getReferralStats, type ReferralStats } from '../../lib/billing'
import { useSpendingPower } from '../../lib/billing/useSpendingPower'
import { readDisplayIdentities } from '../../lib/identityReadAdapter'
import { rendererLogger } from '../../lib/log'
import { buildReferralShareUrl } from '../../lib/referral'
import { webInviteLandingBase } from '../../lib/inviteLandingBase'
import type { AuthUser } from '../../store/auth'

type FailedPart = 'number' | 'stats'
type State = { owner: string | null; key: string; number: number | null; referral: ReferralStats | null; phase: 'loading' | 'ready' | 'failed'; failed: FailedPart[] }
type Event = { type: 'start'; owner: string; key: string; number: number | null }
  | { type: 'settled'; key: string; number: number | null; referral: ReferralStats | null; failed: FailedPart[] }

function transition(state: State, event: Event): State {
  if (event.type === 'start') return {
    owner: event.owner, key: event.key, number: event.number ?? (state.owner === event.owner ? state.number : null),
    referral: null, phase: 'loading', failed: [],
  }
  if (state.key !== event.key) return state
  return { ...state, number: event.number, referral: event.referral,
    phase: event.failed.length ? 'failed' : 'ready', failed: event.failed }
}

/** Invitation identity and stats share one error outlet; results never cross account boundaries. */
export function useReferralCardData(user: AuthUser | null, authLoading: boolean) {
  const hasLandingPage = !!webInviteLandingBase()
  const owner = user?.id ?? null
  const { creditVersion, creditConfirmation, activityRevision } = useSpendingPower(user)
  const knownNumber = user?.gugu_number ?? null
  const identityPending = user?.identityPending === true
  const [attempt, setAttempt] = useState(0)
  // Account confirmation, complete Meta and activity each invalidate the previous read generation.
  const key = JSON.stringify([owner, creditConfirmation, creditVersion, activityRevision, attempt])
  const [state, dispatch] = useReducer(transition, { owner, key, number: knownNumber, referral: null, phase: 'loading', failed: [] })
  useEffect(() => {
    if (!owner || authLoading || identityPending) return
    let active = true
    const controller = new AbortController()
    dispatch({ type: 'start', owner, key, number: knownNumber })
    const number = knownNumber || !hasLandingPage ? Promise.resolve(knownNumber) : readDisplayIdentities([owner], controller.signal).then(rows => {
      const value = rows.find(row => row.id === owner)?.gugu_number
      if (!value || !Number.isFinite(value) || value <= 0) throw new Error('Invitation identity number was not returned')
      return value
    })
    void Promise.allSettled([number, getReferralStats()]).then(([numberResult, statsResult]) => {
      if (!active) return
      const failed: FailedPart[] = []
      if (numberResult.status === 'rejected') { failed.push('number'); rendererLogger('referral').warn({ error: numberResult.reason }, 'invitation number read failed') }
      if (statsResult.status === 'rejected') { failed.push('stats'); rendererLogger('referral').warn({ error: statsResult.reason }, 'invitation stats read failed') }
      dispatch({ type: 'settled', key, number: numberResult.status === 'fulfilled' ? numberResult.value : null,
        referral: statsResult.status === 'fulfilled' ? statsResult.value : null, failed })
    })
    return () => { active = false; controller.abort() }
  }, [key, owner, knownNumber, identityPending, authLoading, hasLandingPage, attempt])
  // Hide the previous version during render, before the effect can start its replacement read.
  const current = state.key === key ? state : { owner, key, number: knownNumber, referral: null, phase: 'loading', failed: [] }
  return { ...current, pending: current.phase === 'loading', hasLandingPage,
    inviteUrl: buildReferralShareUrl(knownNumber ?? current.number), retry: () => setAttempt(value => value + 1) }
}
