import { describe, expect, it } from 'vitest'
import { searchTimestampMicros } from './time'

describe('exact membership timestamps', () => {
  it('keeps the microseconds that Date.parse truncates', () => {
    const early = '2026-10-20T12:00:00.000100Z'
    const late = '2026-10-20T12:00:00.000900Z'
    expect(Date.parse(early)).toBe(Date.parse(late))
    expect(searchTimestampMicros(late) - searchTimestampMicros(early)).toBe(800)
  })
  it('compares offset timestamps and fractional padding as the same instant', () => {
    expect(searchTimestampMicros('2026-10-20T14:00:00.1+02:00')).toBe(searchTimestampMicros('2026-10-20T12:00:00.100000Z'))
    expect(searchTimestampMicros('1969-12-31T23:59:59.999999Z')).toBe(-1)
  })
  it.each(['2026-10-20T12:00:00', '2026-02-30T12:00:00Z', '2026-10-20T12:00:00.1234567Z'])(
    'rejects an ambiguous or invalid timestamp: %s', (value) => {
      expect(() => searchTimestampMicros(value)).toThrow()
    })
})
