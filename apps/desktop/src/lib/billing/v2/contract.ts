import { creditDecimal, type CreditDecimal } from './decimal'

export interface CreditUnitMeta {
  credit_unit_version: 2
  active_credit_unit_version: 1 | 2
  gateway_price_version: 1 | 2
  gateway_currency: 'USD' | 'CNY'
  fx_cny_per_usd: CreditDecimal | null
  fx_source_url: string | null
  fx_asof_date: string | null
  fx_published_at_utc: string | null
}

export type CreditPriceState = 'v2-projection-v1-pricing' | 'v2-active'
export type CreditRead<T> = { rows: T[]; meta: CreditUnitMeta | null }

export class CreditReadContractError extends Error {
  constructor(readonly field: string) {
    super('Credit read contract is unavailable or inconsistent', { cause: { field } })
    this.name = 'CreditReadContractError'
  }
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CreditReadContractError('row')
  return value as Record<string, unknown>
}

export function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') throw new CreditReadContractError(field)
  return value
}

export function nullableText(value: unknown, field: string): string | null {
  return value === null ? null : text(value, field)
}

export function instant(value: unknown, field: string): string {
  const result = text(value, field)
  if (!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(result) || !Number.isFinite(Date.parse(result))) {
    throw new CreditReadContractError(field)
  }
  return result
}

export function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new CreditReadContractError(field)
  return value
}

export function count(value: unknown, field: string): number {
  const result = finiteNumber(value, field)
  if (!Number.isSafeInteger(result) || result < 0) throw new CreditReadContractError(field)
  return result
}

export function decimal(value: unknown, field: string): CreditDecimal {
  try { return creditDecimal(value) } catch { throw new CreditReadContractError(field) }
}

/** Table JSON numbers remain presentation values, not exact decimal accounting inputs. */
export function tableAmount(row: Record<string, unknown>, field: string): number {
  if (row.credit_unit_version !== 2) throw new CreditReadContractError('credit_unit_version')
  return finiteNumber(row[field], field)
}

export function priceState(meta: CreditUnitMeta): CreditPriceState {
  if (meta.active_credit_unit_version === 1 && meta.gateway_price_version === 1 && meta.gateway_currency === 'USD') {
    return 'v2-projection-v1-pricing'
  }
  if (meta.active_credit_unit_version === 2 && meta.gateway_price_version === 2 && meta.gateway_currency === 'CNY') {
    return 'v2-active'
  }
  throw new CreditReadContractError('active/price/currency')
}

export function creditMeta(row: Record<string, unknown>): CreditUnitMeta {
  if (row.credit_unit_version !== 2 || ![1, 2].includes(row.active_credit_unit_version as number)
    || ![1, 2].includes(row.gateway_price_version as number) || !['USD', 'CNY'].includes(row.gateway_currency as string)) {
    throw new CreditReadContractError('version metadata')
  }
  const meta: CreditUnitMeta = {
    credit_unit_version: 2,
    active_credit_unit_version: row.active_credit_unit_version as 1 | 2,
    gateway_price_version: row.gateway_price_version as 1 | 2,
    gateway_currency: row.gateway_currency as 'USD' | 'CNY',
    fx_cny_per_usd: row.fx_cny_per_usd === null ? null : decimal(row.fx_cny_per_usd, 'fx_cny_per_usd'),
    fx_source_url: nullableText(row.fx_source_url, 'fx_source_url'),
    fx_asof_date: nullableText(row.fx_asof_date, 'fx_asof_date'),
    fx_published_at_utc: row.fx_published_at_utc === null ? null : instant(row.fx_published_at_utc, 'fx_published_at_utc'),
  }
  priceState(meta)
  return meta
}

/** Empty RPC arrays carry no metadata; neither function existence nor emptiness proves activation. */
export function rpcRows<T>(data: unknown, parse: (row: Record<string, unknown>) => T): CreditRead<T> {
  if (!Array.isArray(data)) throw new CreditReadContractError('RPC array')
  let meta: CreditUnitMeta | null = null
  const rows = data.map((value) => {
    const row = record(value), current = creditMeta(row)
    if (meta && JSON.stringify(meta) !== JSON.stringify(current)) throw new CreditReadContractError('mixed metadata')
    meta = current
    return parse(row)
  })
  return { rows, meta }
}

/** Reject mixed pricing snapshots before a caller can combine separately cached results. */
export function sameCreditMeta(reads: readonly CreditRead<unknown>[]): CreditUnitMeta | null {
  const metadata = reads.flatMap((read) => read.meta === null ? [] : [read.meta])
  const first = metadata[0] ?? null
  if (metadata.some((value) => JSON.stringify(value) !== JSON.stringify(first))) throw new CreditReadContractError('mixed read metadata')
  return first
}
