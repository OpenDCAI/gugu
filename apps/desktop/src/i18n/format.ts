import { getLocaleSnapshot, i18n } from './runtime'
import type { SupportedLocale } from './locale'

function locale(override?: SupportedLocale): SupportedLocale {
  return override ?? getLocaleSnapshot().resolvedLocale
}

export function formatNumber(
  value: number,
  options?: Intl.NumberFormatOptions,
  localeOverride?: SupportedLocale,
): string {
  return new Intl.NumberFormat(locale(localeOverride), options).format(value)
}

export function formatDate(
  value: Date | number | string,
  options?: Intl.DateTimeFormatOptions,
  localeOverride?: SupportedLocale,
): string {
  const date = value instanceof Date ? value : new Date(value)
  return new Intl.DateTimeFormat(locale(localeOverride), options).format(date)
}

export interface FormatRelativeTimeOptions {
  nowMs?: number
  dateAfterDays?: number
  locale?: SupportedLocale
}

export function formatRelativeTime(
  iso: string | null | undefined,
  { nowMs = Date.now(), dateAfterDays, locale: localeOverride }: FormatRelativeTimeOptions = {},
): string | null {
  if (!iso) return null
  const timestamp = Date.parse(iso)
  if (!Number.isFinite(timestamp)) return null

  const elapsedMinutes = Math.floor(Math.max(0, nowMs - timestamp) / 60_000)
  const resolvedLocale = locale(localeOverride)
  const t = i18n.getFixedT(resolvedLocale, 'common')
  if (elapsedMinutes < 1) return t('relativeTime.justNow')
  if (elapsedMinutes < 60) return t('relativeTime.minutesAgo', { count: elapsedMinutes })

  const elapsedHours = Math.floor(elapsedMinutes / 60)
  if (elapsedHours < 24) return t('relativeTime.hoursAgo', { count: elapsedHours })

  const elapsedDays = Math.floor(elapsedHours / 24)
  if (dateAfterDays !== undefined && elapsedDays >= dateAfterDays) {
    return formatDate(timestamp, { month: 'short', day: 'numeric' }, localeOverride)
  }
  return t('relativeTime.daysAgo', { count: elapsedDays })
}
