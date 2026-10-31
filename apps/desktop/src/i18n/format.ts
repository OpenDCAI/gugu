import {
  formatNumber as formatNumberValue,
  formatDate as formatDateValue,
  formatRelativeTimeParts as formatRelativeParts,
  type DateValue,
  type RelativeTimeOptions,
  type RelativeTimePart,
  type SupportedLocale,
} from '@gugu/session-shared/format'
import { getLocaleSnapshot, i18n } from './runtime'

export { differenceInCalendarDays, formatCalendarDate, toLocalDateTimeInput } from '@gugu/session-shared/format'

function locale(override?: string): string {
  return override ?? getLocaleSnapshot().resolvedLocale
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions, localeOverride?: string): string {
  return formatNumberValue(value, options, locale(localeOverride))
}

export function formatDate(value: DateValue, options?: Intl.DateTimeFormatOptions, localeOverride?: string): string {
  return formatDateValue(value, options, locale(localeOverride))
}

export type FormatRelativeTimeOptions = RelativeTimeOptions & { locale?: SupportedLocale }

export function formatRelativeTimeParts(
  value: DateValue | null | undefined,
  { locale: localeOverride, ...options }: FormatRelativeTimeOptions = { mode: 'elapsed' },
): RelativeTimePart[] | null {
  if (value == null || value === '') return null
  const timestamp = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value)
  if (!Number.isFinite(timestamp)) return null
  const resolvedLocale = localeOverride ?? getLocaleSnapshot().resolvedLocale
  const t = i18n.getFixedT(resolvedLocale, 'common')
  const elapsedKeys = { minute: 'relativeTime.minutesAgo', hour: 'relativeTime.hoursAgo', day: 'relativeTime.daysAgo' } as const
  const compactKeys = {
    second: 'relativeTime.compact.second', minute: 'relativeTime.compact.minute', hour: 'relativeTime.compact.hour',
    day: 'relativeTime.compact.day', month: 'relativeTime.compact.month', year: 'relativeTime.compact.year',
  } as const
  return formatRelativeParts(timestamp, resolvedLocale, {
    now: t('relativeTime.justNow'),
    elapsed: (count, unit) => t(elapsedKeys[unit], { count }),
    compact: (count, unit) => t(compactKeys[unit], { count }),
  }, options)
}

export function formatRelativeTime(value: DateValue | null | undefined, options: FormatRelativeTimeOptions = { mode: 'elapsed' }): string | null {
  return formatRelativeTimeParts(value, options)?.map((part) => part.value).join('') ?? null
}
