/** Framework-free formatting. The host supplies its resolved locale and translated words. */
export const SUPPORTED_LOCALES = ['zh-CN', 'en-US'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];
export type DateValue = Date | number | string;
export type TimeUnit = 'second' | 'minute' | 'hour' | 'day' | 'month' | 'year';

export function formatNumber(value: number, options: Intl.NumberFormatOptions | undefined, locale: string): string {
  return cachedNumberFormat(locale, options ?? {}).format(value);
}

// JSON only represents plain enumerable data. Let Intl itself read inherited, hidden or dynamic options.
function optionsCacheKey(options: object): string | null {
  const prototype = Object.getPrototypeOf(options);
  if (prototype !== Object.prototype && prototype !== null) return null;
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(options))) {
    if (!descriptor.enumerable || !('value' in descriptor)) return null;
    const value: unknown = descriptor.value;
    if (value !== null && !['string', 'number', 'boolean', 'undefined'].includes(typeof value)) return null;
    if (typeof value === 'number' && !Number.isFinite(value)) return null;
  }
  return JSON.stringify(options);
}

// Number/RelativeTime formatters are cached for the same reason as the date ones below: message rows and
// relative-time labels format on a clock, and rebuilding an Intl formatter per call was measurable.
const numberFormats = new Map<string, Intl.NumberFormat>();
function cachedNumberFormat(locale: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const optionsKey = optionsCacheKey(options);
  if (optionsKey === null) return new Intl.NumberFormat(locale, options);
  const key = JSON.stringify([locale, optionsKey]);
  let format = numberFormats.get(key);
  if (!format) numberFormats.set(key, format = new Intl.NumberFormat(locale, options));
  return format;
}

const relativeTimeFormats = new Map<string, Intl.RelativeTimeFormat>();
function cachedRelativeTimeFormat(locale: string, options: Intl.RelativeTimeFormatOptions): Intl.RelativeTimeFormat {
  const optionsKey = optionsCacheKey(options);
  if (optionsKey === null) return new Intl.RelativeTimeFormat(locale, options);
  const key = JSON.stringify([locale, optionsKey]);
  let format = relativeTimeFormats.get(key);
  if (!format) relativeTimeFormats.set(key, format = new Intl.RelativeTimeFormat(locale, options));
  return format;
}

// A formatter fixes its zone at construction. Read the actual default on each call: offset/name probes can
// collide for zones with different summer rules. Pin construction to that zone so no miss poisons another key.
const dateFormats = new Map<string, Intl.DateTimeFormat>();

export function formatDate(value: DateValue, options: Intl.DateTimeFormatOptions | undefined, locale: string): string {
  const optionsKey = optionsCacheKey(options ?? {});
  if (optionsKey === null) return new Intl.DateTimeFormat(locale, options).format(value instanceof Date ? value : new Date(value));
  const timeZone = options?.timeZone === undefined ? new Intl.DateTimeFormat().resolvedOptions().timeZone : options.timeZone;
  const key = JSON.stringify([locale, timeZone, optionsKey]);
  let format = dateFormats.get(key);
  if (!format) dateFormats.set(key, format = new Intl.DateTimeFormat(locale, { ...options, timeZone }));
  return format.format(value instanceof Date ? value : new Date(value));
}

// 12/24 小时跟 locale 默认走(❌ 指定 hourCycle / hour12):界面上的时刻只有这一种写法。
const CLOCK: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };

/** 界面上「几点」的唯一写法:中文 `17:06`,英文 `05:06 PM`。 */
export function formatClock(value: DateValue, locale: string): string {
  return formatDate(value, CLOCK, locale);
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
  const clock = formatClock(date, locale);
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

/**
 * 列表、公告、消息分隔这类日历时间,唯一实现:今天只写时刻;昨天写「昨天」;更早写日期,与聊天日界同一种写法
 * (同年「10月31日」,跨年「2025年10月31日」,英文「Oct 31」)。`withTime` 时昨天与更早也带时刻。
 * 无效时间如实画成「Invalid Date」,❌ 静默成空串:上游数据坏了要看得见。
 */
export function formatCalendarDay(value: DateValue, locale: string, { withTime = false, now = new Date() }: { withTime?: boolean; now?: Date } = {}): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return String(date);
  const days = differenceInCalendarDays(now, date);
  if (days === 0) return formatClock(date, locale);
  if (days === 1) {
    // 英文 Intl 给小写「yesterday」;它常单独当标签用,首字母大写(中文不受影响)。
    const word = cachedRelativeTimeFormat(locale, { numeric: 'auto' }).format(-1, 'day');
    const yesterday = word.charAt(0).toLocaleUpperCase(locale) + word.slice(1);
    return withTime ? `${yesterday} ${formatClock(date, locale)}` : yesterday;
  }
  return formatCalendarDate(date, locale, { includeTime: withTime, now });
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
    // 短形(侧栏、提交列表)与长形是同一个 Intl 单位格式,只差 narrow/long:中文「10分钟 / 3小时」,英文「10m / 3h」。
    if (!addSuffix) return text(cachedNumberFormat(locale, { style: 'unit', unit, unitDisplay: compact ? 'narrow' : 'long' }).format(count));
    return cachedRelativeTimeFormat(locale, { numeric: 'always', style: compact ? 'narrow' : 'long' })
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


/**
 * Token 数量的统一写法:四舍五入到千之后满 1000 就进位到 M(999,600 → `1.0M`,999,400 → `999k`)。
 * 上下文指示器、模型 tooltip 和压缩行都从这一份取,❌ 各自造一套进位规则(评审)。
 */
export function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) {
    const thousands = Math.round(value / 1_000);
    return thousands >= 1_000 ? `${(value / 1_000_000).toFixed(1)}M` : `${thousands}k`;
  }
  return String(value);
}
