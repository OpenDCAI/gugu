import { creditFromUnits, creditUnits, type CreditAmount } from '@gugu/core/billing/creditAmount'

/** Currency labels retain exact amounts. VChart receives only dimensionless drawing coordinates. */
export function creditChartScale(values: readonly CreditAmount[]) {
  const decimal = values.some((value) => typeof value === 'string')
  const scale = decimal ? values.reduce((largest, value) => {
    const amount = creditUnits(value), magnitude = amount < 0n ? -amount : amount
    return magnitude > largest ? magnitude : largest
  }, 1n) : 1n
  return {
    formatCoordinate(coordinate: string | number, format: (value: CreditAmount) => string): string {
      const position = typeof coordinate === 'number' ? coordinate : Number(coordinate)
      if (!Number.isFinite(position)) throw new TypeError('Invalid chart coordinate')
      if (!decimal) return format(position)
      const amount = (scale * BigInt(Math.round(position * 1_000_000_000))) / 1_000_000_000n
      // An axis tick may fall below a single storage unit. Keep its nonzero display marker;
      // this label never replaces a source amount, tooltip datum or total.
      return format(creditFromUnits(position > 0 && amount === 0n ? 1n : amount))
    },
    coordinate(value: CreditAmount): number {
      if (!decimal) {
        if (typeof value !== 'number') throw new TypeError('Non-numeric chart count')
        return value
      }
      return Number((creditUnits(value) * 1_000_000_000n) / scale) / 1_000_000_000
    },

  }
}
