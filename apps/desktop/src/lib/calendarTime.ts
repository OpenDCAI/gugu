// @@@calendar-time (#1909) - 日历式时间戳唯一实现（今天→HH:MM / 昨天 / 更早→日期）。
// 档位裁定（准绳见 #1909 评论）：
// * 日边界 = 本地日历日比较——不是滚动 24h 毫秒窗（旧 AnnouncementDrawer 的 ms-floor 会把昨晚标成今天）；
// * 无星期档——准绳全库零星期字符串；旧三份的滚动星期窗还会与今天撞名（周五看上周五显示「星期五」）；
// * 日期 M/D 不补零；跨年前缀 YYYY/（准绳无年份档，跨年加年是明确标注的本地增强，一年内与准绳一致）；
// * HH:MM 固定 24 小时制，不走系统 locale（产品文案全中文，AM/PM 混排不成立）；
// * 无效时间戳如实渲染成垃圾（NaN/NaN）而非静默空串——上游数据坏了要看得见（fail loud）；
//   只有 null/undefined 是合法域态（如 chat 还没有消息）→ 空串。
// 相对时间族（N 分钟前/后）不属于这里：过去向 #1900/#1908 家族收敛，未来向（AgentTasksPane）保持原状。

import { formatDate, getLocaleSnapshot, type SupportedLocale } from '@/i18n'

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

type CalendarLocale = SupportedLocale

// One formatter per locale for the whole app: every message row formats its time, and building an
// Intl.DateTimeFormat per call was a measurable part of switching chats.
const hhmmFormats: Partial<Record<CalendarLocale, Intl.DateTimeFormat>> = {}

function hhmm(date: Date, locale: CalendarLocale): string {
  if (!Number.isFinite(date.getTime())) return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  return (hhmmFormats[locale] ??= new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' })).format(date)
}

function isSameCalendarDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/** null = 今天（调用方决定只显示 HH:MM）；其余返回「昨天」或日期档文本。 */
function dayLabel(date: Date, now: Date, locale: CalendarLocale): string | null {
  if (isSameCalendarDay(date, now)) return null
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (isSameCalendarDay(date, yesterday)) {
    return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(-1, 'day')
  }
  if (Number.isFinite(date.getTime())) {
    return formatDate(date, {
      ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' as const }),
      month: 'numeric',
      day: 'numeric',
    }, locale)
  }
  const monthDay = `${date.getMonth() + 1}/${date.getDate()}`
  return date.getFullYear() === now.getFullYear() ? monthDay : `${date.getFullYear()}/${monthDay}`
}

/** 列表族（会话列表、公告、历史）：今天→HH:MM；昨天→昨天；同年→M/D；跨年→YYYY/M/D。null/undefined→''。 */
export function formatCalendarDay(
  iso: string | null | undefined,
  now: Date = new Date(),
  locale: CalendarLocale = getLocaleSnapshot().resolvedLocale,
): string {
  if (!iso) return ''
  const date = new Date(iso)
  return dayLabel(date, now, locale) ?? hhmm(date, locale)
}

/** 分隔线族（消息时间分隔）：列表族每档带 HH:MM——今天→HH:MM；昨天→昨天 HH:MM；更早→日期 HH:MM。 */
export function formatCalendarDayTime(
  iso: string,
  now: Date = new Date(),
  locale: CalendarLocale = getLocaleSnapshot().resolvedLocale,
): string {
  const date = new Date(iso)
  const label = dayLabel(date, now, locale)
  return label === null ? hhmm(date, locale) : `${label} ${hhmm(date, locale)}`
}
