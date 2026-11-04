/** Framework-free formatting. The host supplies its resolved locale and translated words. */
export const SUPPORTED_LOCALES = ['zh-CN', 'en-US'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];
export type DateValue = Date | number | string;
export type TimeUnit = 'second' | 'minute' | 'hour' | 'day' | 'month' | 'year';

export function formatNumber(value: number, options: Intl.NumberFormatOptions | undefined, locale: string): string {
  return cachedNumberFormat(locale, options ?? {}).format(value);
}

// Number/RelativeTime formatters are cached for the same reason as the date ones below: message rows and
// relative-time labels format on a clock, and rebuilding an Intl formatter per call was measurable.
const numberFormats = new Map<string, Intl.NumberFormat>();
function cachedNumberFormat(locale: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let format = numberFormats.get(key);
  if (!format) numberFormats.set(key, format = new Intl.NumberFormat(locale, options));
  return format;
}

const relativeTimeFormats = new Map<string, Intl.RelativeTimeFormat>();
function cachedRelativeTimeFormat(locale: string, options: Intl.RelativeTimeFormatOptions): Intl.RelativeTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let format = relativeTimeFormats.get(key);
  if (!format) relativeTimeFormats.set(key, format = new Intl.RelativeTimeFormat(locale, options));
  return format;
}

// One formatter per locale, options and time zone: every message row formats its time, and building an
// Intl.DateTimeFormat per call was a measurable part of switching chats. A formatter fixes the zone it was built in,
// so the key carries the zone NAME and the current UTC offset: 只带 offset 不够 —— 利马与纽约同时刻 offset 相同、
// 规则不同(评审:7 月 4 日会被画成 7 月 3 日)。时区名本身经由下面的探针取 —— 每次调用都问 Intl 太贵。
const dateFormats = new Map<string, Intl.DateTimeFormat>();

// 每次调用都去问 Intl 要时区名(≈55µs)的话,这份缓存就白做了(评审)。用 Date.toString() 里的时区段 + offset
// 当探针(≈1µs):探针变了(切时区、夏令时)立刻换一份;探针看不出来的两个时区(纽约/坎昆这种同段同 offset)
// 最多 5 秒后再确认一次。
const ZONE_RECHECK_MS = 5_000;
let zoneMemo: { probe: string; name: string; at: number } | null = null;

function timeZoneName(now: number): string {
  const date = new Date(now);
  const raw = date.toString();
  const open = raw.indexOf('(');
  const probe = `${open < 0 ? 'local' : raw.slice(open + 1, -1)}|${date.getTimezoneOffset()}`;
  if (!zoneMemo || zoneMemo.probe !== probe || now - zoneMemo.at >= ZONE_RECHECK_MS) {
    zoneMemo = { probe, at: now, name: Intl.DateTimeFormat().resolvedOptions().timeZone };
  }
  return zoneMemo.name;
}

export function formatDate(value: DateValue, options: Intl.DateTimeFormatOptions | undefined, locale: string): string {
  const now = Date.now();
  const key = `${locale}|${timeZoneName(now)}|${new Date(now).getTimezoneOffset()}|${JSON.stringify(options ?? {})}`;
  let format = dateFormats.get(key);
  if (!format) dateFormats.set(key, format = new Intl.DateTimeFormat(locale, options));
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
