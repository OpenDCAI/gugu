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

import { formatCalendarDay as formatCalendarDayValue, formatClock as formatClockValue } from '@gugu/session-shared/format'

export { differenceInCalendarDays, formatCalendarDate, toLocalDateTimeInput } from '@gugu/session-shared/format'

/** 会话列表、公告、消息分隔的日历时间(见 session-shared `formatCalendarDay`);没有时间(还没有消息)是空串。 */
export function formatCalendarDay(value: DateValue | null | undefined, options: { withTime?: boolean; now?: Date } = {}): string {
  return value == null || value === '' ? '' : formatCalendarDayValue(value, getLocaleSnapshot().resolvedLocale, options)
}

function locale(override?: string): string {
  return override ?? getLocaleSnapshot().resolvedLocale
}

/** 界面上「几点」(见 session-shared `formatClock`)。 */
export function formatClock(value: DateValue, localeOverride?: string): string {
  return formatClockValue(value, locale(localeOverride))
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
  return formatRelativeParts(timestamp, resolvedLocale, {
    now: t('relativeTime.justNow'),
    elapsed: (count, unit) => t(elapsedKeys[unit], { count }),
  }, options)
}

export function formatRelativeTime(value: DateValue | null | undefined, options: FormatRelativeTimeOptions = { mode: 'elapsed' }): string | null {
  return formatRelativeTimeParts(value, options)?.map((part) => part.value).join('') ?? null
}
