import { creditUnits, type CreditAmount } from '@gugu/core/billing/creditAmount'

/** Only pixel geometry is approximate. The source amount never becomes a floating value. */
export function creditRatio(numerator: CreditAmount, denominator: CreditAmount): number {
  if (typeof numerator === 'number' && typeof denominator === 'number') {
    return denominator > 0 ? Math.max(0, Math.min(1, numerator / denominator)) : 0
  }
  const n = creditUnits(numerator), d = creditUnits(denominator)
  if (d <= 0n || n <= 0n) return 0
  if (n >= d) return 1
  return Number((n * 1_000_000n) / d) / 1_000_000
}
