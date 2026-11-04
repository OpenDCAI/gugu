import type { QuotaWindows } from '@gugu/core/billing'
import { CreditReadContractError, priceState, sameCreditMeta, type CreditRead, type CreditUnitMeta } from './contract'
import type { createCreditV2Reader, QuotaWindowsV2 } from './readers'

export type CreditV2State = 'not-active' | 'unknown' | 'account-changed' | 'not-installed' | 'inconsistent'

export class CreditV2StateError extends Error {
  constructor(readonly state: CreditV2State, cause?: unknown) {
    super(`Credit v2 state: ${state}`, { cause })
    this.name = 'CreditV2StateError'
  }
}

function requireActive(meta: CreditUnitMeta | null): asserts meta is CreditUnitMeta {
  if (meta === null) throw new CreditV2StateError('unknown')
  if (priceState(meta) !== 'v2-active') throw new CreditV2StateError('not-active')
}

export function quotaProjection(row: QuotaWindowsV2): QuotaWindows {
  return {
    plan_id: row.planId, period_credits: row.periodCredits, period_used: row.periodUsed,
    outstanding_credits: row.outstandingCredits, credits_per_usd: row.creditsPerUsd,
    period_started_at: row.startedAt, period_ends_at: row.endsAt,
  }
}

/** No v1 read exists here. A batch belongs to one current user and one complete version tuple. */
export function createActiveCreditV2Reader(reader: ReturnType<typeof createCreditV2Reader>, currentUserId: () => Promise<string>) {
  async function sameUser(expected: string): Promise<void> {
    if (await currentUserId() !== expected) throw new CreditV2StateError('account-changed')
  }

  async function rows<T>(work: () => Promise<CreditRead<T>>): Promise<CreditRead<T>> {
    const user = await currentUserId()
    const read = await work()
    const meta = read.meta ?? (await reader.pricingMetadata()).meta
    requireActive(meta)
    await sameUser(user)
    return { ...read, meta }
  }

  async function table<T>(work: () => Promise<T>): Promise<T> {
    const user = await currentUserId()
    const before = await reader.pricingMetadata()
    requireActive(before.meta)
    const value = await work()
    const after = await reader.pricingMetadata()
    requireActive(after.meta)
    sameCreditMeta([before, after])
    await sameUser(user)
    return value
  }

  async function account() {
    const read = await rows(async () => {
      const [membership, quota] = await Promise.all([reader.membership(), reader.quota()])
      const meta = sameCreditMeta([membership, quota])
      const plan = membership.rows[0], window = quota.rows[0]
      if (!plan || !window) throw new CreditV2StateError('unknown')
      if (plan.planId !== window.planId) throw new CreditReadContractError('account plan')
      return { rows: [{ balance: plan.balanceCredits, windows: quotaProjection(window) }], meta }
    })
    return { ...read.rows[0], meta: read.meta! }
  }

  return { rows, table, account }
}

export function classifyCreditV2Error(error: unknown): unknown {
  if (error instanceof CreditV2StateError) return error
  if (error instanceof CreditReadContractError) return new CreditV2StateError('inconsistent', error)
  if (error instanceof Error && error.cause && typeof error.cause === 'object'
    && 'code' in error.cause && error.cause.code === 'PGRST202') return new CreditV2StateError('not-installed', error)
  // Authentication, permission, CORS and transport failures retain their actual error.
  return error
}
