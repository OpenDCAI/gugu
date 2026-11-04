/** Exact NUMERIC(30,8) text from the billing RPC boundary. */
export type CreditDecimal = string & { readonly __creditDecimal: unique symbol }
/** Number is retained for table JSON and existing non-RPC callers; RPC text stays text. */
export type CreditAmount = number | CreditDecimal
const SCALE = 100_000_000n

export function creditDecimal(value: unknown): CreditDecimal {
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d{1,8})?$/.test(value)) throw new TypeError('Expected a finite decimal amount string')
  const negative = value.startsWith('-')
  const [rawWhole, fraction = ''] = (negative ? value.slice(1) : value).split('.')
  const whole = rawWhole.replace(/^0+(?=\d)/, '')
  if (whole.length > 22) throw new RangeError('Amount exceeds NUMERIC(30,8)')
  const tail = fraction.replace(/0+$/, '')
  return `${negative && !(whole === '0' && tail === '') ? '-' : ''}${whole}${tail ? `.${tail}` : ''}` as CreditDecimal
}

function numberText(value: number): string {
  if (!Number.isFinite(value)) throw new TypeError('Expected a finite numeric presentation amount')
  const raw = String(value)
  if (!raw.includes('e')) return raw
  const [coefficient, exponentText] = raw.split('e')
  const negative = coefficient.startsWith('-')
  const [whole, fraction = ''] = coefficient.replace(/^-/, '').split('.')
  const digits = whole + fraction, point = whole.length + parseInt(exponentText, 10)
  const expanded = point <= 0 ? `0.${'0'.repeat(-point)}${digits}`
    : point >= digits.length ? digits + '0'.repeat(point - digits.length) : `${digits.slice(0, point)}.${digits.slice(point)}`
  return `${negative ? '-' : ''}${expanded}`
}

export function creditUnits(value: CreditAmount): bigint {
  const text = creditDecimal(typeof value === 'number' ? numberText(value) : value)
  const [whole, fraction = ''] = text.replace(/^-/, '').split('.')
  const magnitude = BigInt(whole) * SCALE + BigInt(fraction.padEnd(8, '0'))
  return text.startsWith('-') ? -magnitude : magnitude
}

export function creditFromUnits(value: bigint): CreditDecimal {
  const magnitude = value < 0n ? -value : value
  return creditDecimal(`${value < 0n ? '-' : ''}${magnitude / SCALE}.${String(magnitude % SCALE).padStart(8, '0')}`)
}

export function addCreditDecimals(left: CreditDecimal, right: CreditDecimal): CreditDecimal {
  return creditFromUnits(creditUnits(left) + creditUnits(right))
}
export function subtractCreditDecimals(left: CreditDecimal, right: CreditDecimal): CreditDecimal {
  return creditFromUnits(creditUnits(left) - creditUnits(right))
}
export function compareCreditDecimals(left: CreditDecimal, right: CreditDecimal): -1 | 0 | 1 {
  return compareCreditAmounts(left, right)
}
export function compareCreditAmounts(left: CreditAmount, right: CreditAmount): -1 | 0 | 1 {
  if (typeof left === 'number' && typeof right === 'number') return left < right ? -1 : left > right ? 1 : 0
  const a = creditUnits(left), b = creditUnits(right)
  return a < b ? -1 : a > b ? 1 : 0
}
export function addCreditAmounts(left: CreditAmount, right: CreditAmount): CreditAmount {
  return typeof left === 'number' && typeof right === 'number' ? left + right : creditFromUnits(creditUnits(left) + creditUnits(right))
}
export function subtractCreditAmounts(left: CreditAmount, right: CreditAmount): CreditAmount {
  return typeof left === 'number' && typeof right === 'number' ? left - right : creditFromUnits(creditUnits(left) - creditUnits(right))
}
export function maxCreditAmount(left: CreditAmount, right: CreditAmount): CreditAmount {
  return compareCreditAmounts(left, right) >= 0 ? left : right
}
export function requireCreditAmount(value: CreditAmount, field: string): CreditAmount {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  try { return creditDecimal(value) } catch { throw new Error('Invalid credit amount', { cause: { field } }) }
}
