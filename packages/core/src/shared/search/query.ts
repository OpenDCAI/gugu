import type { SearchQuery } from './types'

export class SearchQueryError extends Error {
  readonly position: number
  constructor(message: string, position: number) {
    super(message)
    this.name = 'SearchQueryError'
    this.position = position
  }
}

export interface SearchTerm {
  text: string
  phrase: boolean
  exclude: boolean
}

interface Token extends SearchTerm { start: number; raw: string }

function tokenize(input: string): Token[] {
  const result: Token[] = []
  let index = 0
  while (index < input.length) {
    if (/\s/u.test(input[index])) { index += 1; continue }
    const start = index
    const exclude = input[index] === '-'
    if (exclude) index += 1
    const phrase = input[index] === '"'
    let text = ''
    let quoted = false
    while (index < input.length && (quoted || !/\s/u.test(input[index]))) {
      const character = input[index++]
      if (character === '\\' && index < input.length && /["\\]/u.test(input[index])) text += input[index++]
      else if (character === '"') quoted = !quoted
      else text += character
    }
    if (quoted) throw new SearchQueryError('Unclosed search quote', start)
    if (!text) throw new SearchQueryError('A search term is empty', start)
    result.push({ text, phrase, exclude, start, raw: input.slice(start, index) })
  }
  return result
}

/** Terms are shared by SQL compilation and highlighting, including quote/exclusion semantics. */
export function parseSearchTerms(input: string): SearchTerm[] {
  return tokenize(input).map(({ text, phrase, exclude }) => ({ text, phrase, exclude }))
}

export interface SearchParseContext {
  /** Injected for relative dates; parsing never reads the wall clock. */
  now: Date
  resolveIn?: (value: string) => NonNullable<SearchQuery['filters']['in']>
  resolveFrom?: (value: string) => string[]
  filters?: SearchQuery['filters']
  sort?: SearchQuery['sort']
  origin?: SearchQuery['origin']
}

function day(year: number, month: number, date: number): string {
  const value = new Date(Date.UTC(year, month - 1, date))
  if (value.getUTCFullYear() !== year || value.getUTCMonth() !== month - 1 || value.getUTCDate() !== date) {
    throw new Error('Invalid calendar date')
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(date).padStart(2, '0')}`
}

function shiftedDay(value: Date, delta: number): string {
  const shifted = new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate() + delta))
  return day(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate())
}

/** Calendar operations use the device's local day; SQL binds the corresponding local midnights. */
function dateRange(value: string, now: Date): { start: string; end?: string } {
  if (!Number.isFinite(now.getTime())) throw new Error('The search date context is invalid')
  if (value === '昨天') return { start: shiftedDay(now, -1) }
  if (value === '上周') {
    const monday = -((now.getDay() + 6) % 7)
    return { start: shiftedDay(now, monday - 7), end: shiftedDay(now, monday) }
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value)
  if (iso) return { start: day(Number(iso[1]), Number(iso[2]), Number(iso[3])) }
  const local = /^(\d{1,2})月(\d{1,2})日$/u.exec(value)
  if (local) return { start: day(now.getFullYear(), Number(local[1]), Number(local[2])) }
  throw new Error('Use a calendar date, 昨天 or 上周')
}

const HAS_FILTERS = ['file', 'image', 'link'] as const
const IS_FILTERS = ['mention', 'whisper'] as const

export function parseQuery(input: string, context: SearchParseContext): SearchQuery {
  const filters: SearchQuery['filters'] = { ...context.filters }
  const remaining: string[] = []
  const setDate = (key: 'before' | 'after' | 'on', value: string, start: number) => {
    const range = dateRange(value, context.now)
    if (key === 'on' && range.end) {
      if (filters.after || filters.before || filters.on) throw new SearchQueryError('Conflicting search dates', start)
      filters.after = range.start
      filters.before = range.end
    } else {
      const date = key === 'after' && range.end ? range.end : range.start
      if (filters[key] && filters[key] !== date) throw new SearchQueryError('Conflicting search dates', start)
      filters[key] = date
    }
  }
  for (const token of tokenize(input)) {
    const modifier = !token.phrase && /^([a-z]+):(.*)$/iu.exec(token.text)
    try {
      if (!modifier || /^(https?|mailto)$/iu.test(modifier[1])) {
        if (!token.phrase && !token.exclude && /^(昨天|上周|\d{1,2}月\d{1,2}日)$/u.test(token.text)) setDate('on', token.text, token.start)
        else remaining.push(token.raw)
        continue
      }
      const [, rawKey, value] = modifier
      const key = rawKey.toLowerCase()
      if (token.exclude) throw new Error('Exclude a text term, not a filter')
      if (!value) throw new Error(`The ${key}: filter is empty`)
      if (key === 'in') {
        const matches = context.resolveIn?.(value)
        if (!matches || matches.length !== 1) throw new Error('Choose one unambiguous conversation for in:')
        filters.in = [...(filters.in ?? []), matches[0]]
      } else if (key === 'from') {
        const matches = context.resolveFrom?.(value)
        if (!matches || matches.length !== 1) throw new Error('Choose one unambiguous sender for from:')
        filters.from = [...new Set([...(filters.from ?? []), matches[0]])]
      } else if (key === 'has') {
        const kind = HAS_FILTERS.find((candidate) => candidate === value)
        if (!kind) throw new Error('Unknown has: filter')
        filters.has = [...new Set([...(filters.has ?? []), kind])]
      } else if (key === 'is') {
        const kind = IS_FILTERS.find((candidate) => candidate === value)
        if (!kind) throw new Error('Unknown is: filter')
        filters.is = [...new Set([...(filters.is ?? []), kind])]
      } else if (key === 'before' || key === 'after' || key === 'on') setDate(key, value, token.start)
      else throw new Error(`Unknown search filter: ${rawKey}`)
    } catch (error) {
      if (error instanceof SearchQueryError) throw error
      throw new SearchQueryError(error instanceof Error ? error.message : 'Invalid search filter', token.start)
    }
  }
  return {
    text: remaining.join(' '), filters,
    sort: context.sort ?? (filters.in?.length === 1 ? 'recent' : 'relevant'),
    ...(context.origin ? { origin: context.origin } : {}),
  }
}
