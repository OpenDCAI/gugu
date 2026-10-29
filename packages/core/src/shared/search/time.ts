/** Preserve PostgreSQL's microsecond membership boundary instead of Date's millisecond truncation. */
export function searchTimestampMicros(value: string): number {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/u.exec(value)
  if (!match) throw new Error('Search timestamps need an explicit UTC offset and at most six fractional digits')
  const [year, month, day] = value.slice(0, 10).split('-').map(Number)
  const calendar = new Date(0)
  calendar.setUTCFullYear(year, month - 1, day)
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) {
    throw new Error('Search timestamp calendar date is invalid')
  }
  const result = Date.parse(match[1] + match[3]) * 1000 + Number((match[2] ?? '').padEnd(6, '0'))
  if (!Number.isSafeInteger(result)) throw new Error('Search timestamp is outside the exact integer range')
  return result
}
