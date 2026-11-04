import { creditUnits, type CreditDecimal } from '@gugu/core/billing/creditAmount'
export { creditDecimal, addCreditDecimals, subtractCreditDecimals, compareCreditDecimals, type CreditDecimal } from '@gugu/core/billing/creditAmount'

/** Round only at presentation; no RPC amount passes through Number. */
export function formatCreditDecimal(value: CreditDecimal, locale: 'en-US' | 'zh-CN'): string {
  const amount = creditUnits(value)
  if (amount > 0n && amount < 1_000_000n) return '<0.01'
  const magnitude = amount < 0n ? -amount : amount
  const cents = (magnitude + 500_000n) / 1_000_000n
  const whole = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(cents / 100n)
  const tail = String(cents % 100n).padStart(2, '0').replace(/0+$/, '')
  return `${amount < 0n ? '-' : ''}${whole}${tail ? `.${tail}` : ''}`
}
