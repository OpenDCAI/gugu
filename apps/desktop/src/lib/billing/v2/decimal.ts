/** Exact finite NUMERIC(30,8) values returned as text by billing's v2 RPCs. */
export type CreditDecimal = string & { readonly __creditDecimal: unique symbol }

const SCALE = 100_000_000n

export function creditDecimal(value: unknown): CreditDecimal {
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d{1,8})?$/.test(value)) {
    throw new TypeError('Expected a finite decimal amount string')
  }
  const negative = value.startsWith('-')
  const [rawWhole, fraction = ''] = (negative ? value.slice(1) : value).split('.')
  const whole = rawWhole.replace(/^0+(?=\d)/, '')
  if (whole.length > 22) throw new RangeError('Amount exceeds NUMERIC(30,8)')
  const tail = fraction.replace(/0+$/, '')
  const zero = whole === '0' && tail === ''
  return `${negative && !zero ? '-' : ''}${whole}${tail ? `.${tail}` : ''}` as CreditDecimal
}

function units(value: CreditDecimal): bigint {
  const [whole, fraction = ''] = value.replace(/^-/, '').split('.')
  const magnitude = BigInt(whole) * SCALE + BigInt(fraction.padEnd(8, '0'))
  return value.startsWith('-') ? -magnitude : magnitude
}

function fromUnits(value: bigint): CreditDecimal {
  const magnitude = value < 0n ? -value : value
  return creditDecimal(`${value < 0n ? '-' : ''}${magnitude / SCALE}.${String(magnitude % SCALE).padStart(8, '0')}`)
}

export function addCreditDecimals(left: CreditDecimal, right: CreditDecimal): CreditDecimal {
  return fromUnits(units(left) + units(right))
}

export function subtractCreditDecimals(left: CreditDecimal, right: CreditDecimal): CreditDecimal {
  return fromUnits(units(left) - units(right))
}

export function compareCreditDecimals(left: CreditDecimal, right: CreditDecimal): -1 | 0 | 1 {
  const a = units(left), b = units(right)
  return a < b ? -1 : a > b ? 1 : 0
}

/** Round only at presentation; no RPC amount passes through Number. */
export function formatCreditDecimal(value: CreditDecimal, locale: 'en-US' | 'zh-CN'): string {
  const amount = units(value)
  if (amount > 0n && amount < 1_000_000n) return '<0.01'
  const magnitude = amount < 0n ? -amount : amount
  const cents = (magnitude + 500_000n) / 1_000_000n
  const whole = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(cents / 100n)
  const tail = String(cents % 100n).padStart(2, '0').replace(/0+$/, '')
  return `${amount < 0n ? '-' : ''}${whole}${tail ? `.${tail}` : ''}`
}
