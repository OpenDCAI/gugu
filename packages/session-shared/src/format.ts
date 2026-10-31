/** Framework-free formatting. The host supplies its resolved locale and translated words. */
export const SUPPORTED_LOCALES = ['zh-CN', 'en-US'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];
export type DateValue = Date | number | string;
export type TimeUnit = 'second' | 'minute' | 'hour' | 'day' | 'month' | 'year';

export function formatNumber(value: number, options: Intl.NumberFormatOptions | undefined, locale: string): string {
  return new Intl.NumberFormat(locale, options).format(value);
}

export function formatDate(value: DateValue, options: Intl.DateTimeFormatOptions | undefined, locale: string): string {
  return new Intl.DateTimeFormat(locale, options).format(value instanceof Date ? value : new Date(value));
}

export function formatCalendarDate(
  value: DateValue,
  locale: string,
  { includeYear = false, includeTime = true, now = new Date() }: { includeYear?: boolean; includeTime?: boolean; now?: Date } = {},
): string {
  const date = value instanceof Date ? value : new Date(value);
  const year = includeYear || date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined;
  const day = formatDate(date, { year, month: 'short', day: 'numeric' }, locale).replaceAll(', ', ' ');
  if (!includeTime) return day;
  const clock = formatDate(date, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }, locale);
  return `${day}${locale.startsWith('zh') ? ' ' : ', '}${clock}`;
}

/** Local calendar fields keep 23/25-hour DST days one calendar day apart. */
export function differenceInCalendarDays(later: Date | number, earlier: Date | number): number {
  const calendarDay = (value: Date | number) => {
    const date = new Date(value);
    const utc = new Date(0);
    utc.setUTCFullYear(date.getFullYear(), date.getMonth(), date.getDate());
    return utc.getTime();
  };
  return Math.round((calendarDay(later) - calendarDay(earlier)) / 86_400_000);
}

/** datetime-local uses local wire fields, without UTC conversion or localized display text. */
export function toLocalDateTimeInput(value: Date | number): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new RangeError('Invalid time value');
  const two = (part: number) => String(part).padStart(2, '0');
  return `${String(date.getFullYear()).padStart(4, '0')}-${two(date.getMonth() + 1)}-${two(date.getDate())}T${two(date.getHours())}:${two(date.getMinutes())}`;
}

export interface RelativeTimeWords {
  now: string;
  elapsed: (count: number, unit: 'minute' | 'hour' | 'day') => string;
  compact: (count: number, unit: TimeUnit) => string;
}

export type RelativeTimeOptions = { nowMs?: number } & (
  | { mode: 'elapsed'; dateAfterDays?: number }
  | { mode: 'strict'; addSuffix?: boolean }
  | { mode: 'compact'; addSuffix?: boolean }
);

export interface RelativeTimePart {
  type: 'value' | 'suffix';
  value: string;
}

// Strict numerical boundaries retain date-fns 4.4.0 semantics; its MIT notice is in THIRD_PARTY_NOTICES.md.
function timezoneOffset(date: Date): number {
  const utc = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds()));
  utc.setUTCFullYear(date.getFullYear());
  return date.getTime() - utc.getTime();
}

function strictDistance(timestamp: number, nowMs: number, round: (value: number) => number): { count: number; unit: TimeUnit } {
  const later = new Date(Math.max(timestamp, nowMs));
  const earlier = new Date(Math.min(timestamp, nowMs));
  const milliseconds = later.getTime() - earlier.getTime();
  const minutes = milliseconds / 60_000;
  const calendarMinutes = (milliseconds - timezoneOffset(later) + timezoneOffset(earlier)) / 60_000;
  if (minutes < 1) return { count: round(milliseconds / 1000), unit: 'second' };
  if (minutes < 60) return { count: round(minutes), unit: 'minute' };
  if (minutes < 1440) return { count: round(minutes / 60), unit: 'hour' };
  if (calendarMinutes < 43_200) return { count: round(calendarMinutes / 1440), unit: 'day' };
  if (calendarMinutes < 525_600) {
    const months = round(calendarMinutes / 43_200);
    return months === 12 ? { count: 1, unit: 'year' } : { count: months, unit: 'month' };
  }
  return { count: round(calendarMinutes / 525_600), unit: 'year' };
}

export function formatRelativeTimeParts(
  timestamp: number,
  locale: SupportedLocale,
  words: RelativeTimeWords,
  options: RelativeTimeOptions,
): RelativeTimePart[] {
  const nowMs = options.nowMs ?? Date.now();
  const text = (value: string): RelativeTimePart[] => [{ type: 'value', value }];
  const distanceParts = (compact: boolean, addSuffix: boolean): RelativeTimePart[] => {
    const { count, unit } = strictDistance(timestamp, nowMs, compact ? Math.floor : Math.round);
    if (!addSuffix) return text(compact
      ? words.compact(count, unit)
      : new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'long' }).format(count));
    return new Intl.RelativeTimeFormat(locale, { numeric: 'always', style: compact ? 'narrow' : 'long' })
      .formatToParts(timestamp > nowMs ? count : -count, unit)
      .map((part): RelativeTimePart => ({ type: part.type === 'literal' ? 'suffix' : 'value', value: part.value }));
  };

  switch (options.mode) {
    case 'elapsed': {
      const minutes = Math.floor(Math.max(0, nowMs - timestamp) / 60_000);
      if (minutes < 1) return text(words.now);
      if (minutes < 60) return text(words.elapsed(minutes, 'minute'));
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return text(words.elapsed(hours, 'hour'));
      const days = Math.floor(hours / 24);
      return text(options.dateAfterDays !== undefined && days >= options.dateAfterDays
        ? formatDate(timestamp, { month: 'short', day: 'numeric' }, locale)
        : words.elapsed(days, 'day'));
    }
    case 'strict':
      return distanceParts(false, options.addSuffix ?? true);
    case 'compact':
      return nowMs - timestamp < 60_000 ? text(words.now) : distanceParts(true, options.addSuffix ?? false);
  }
  options satisfies never;
  throw new Error('Unknown relative-time mode');
}

export function formatRelativeTime(timestamp: number, locale: SupportedLocale, words: RelativeTimeWords, options: RelativeTimeOptions): string {
  return formatRelativeTimeParts(timestamp, locale, words, options).map((part) => part.value).join('');
}
