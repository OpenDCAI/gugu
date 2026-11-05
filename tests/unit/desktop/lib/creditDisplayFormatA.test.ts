// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { creditCount, formatCredits, formatUsageCredits } from '../../../../apps/desktop/src/lib/billing/spendingPowerCopy'

describe('credit display preserves the shared two-decimal contract', () => {
  it.each([
    [0, '0'],
    [0.0001, '<0.01'],
    [0.0099, '<0.01'],
    [0.01, '0.01'],
    [1, '1'],
    [1_000_000_000.25, '1,000,000,000.25'],
    [-0.01, '-0.01'],
    [-12.345, '-12.35'],
  ] as const)('formats %s consistently in balances and usage', (amount, expected) => {
    expect(formatCredits(amount, 'en-US')).toBe(expected)
    expect(formatUsageCredits(amount, 'en-US')).toBe(expected)
    expect(formatCredits(amount, 'zh-CN')).toBe(expected)
  })

  it('uses the displayed amount for singular and plural copy', () => {
    expect(formatCredits(0.999, 'en-US')).toBe('1')
    expect(creditCount(0.999)).toBe(1)
    expect(creditCount(0.0001)).toBe(0)
  })
})
