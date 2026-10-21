// #7199 手机当设备 —— 时间的写法。这段 JS 跑在手机的 WebView 里:Date 的「本地」就是手机的时区。

export const pad = (n: number, width = 2) => String(Math.abs(Math.trunc(n))).padStart(width, '0')

export function utcOffsetOf(date: Date): string {
  const minutes = -date.getTimezoneOffset()
  return `${minutes >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(minutes) / 60))}:${pad(Math.abs(minutes) % 60)}`
}

/** 手机本地时间、带偏移的 ISO(`2026-10-16T15:00:00+08:00`)—— 助理拿去说「明天下午三点」不用再换算。 */
export function localIso(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${utcOffsetOf(d)}`
}

/** 手机本地的日历日 YYYY-MM-DD。 */
export function localDate(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 手机本地某天零点(offset 天之后)。 */
export function localDayStartMs(ms: number, offsetDays = 0): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + offsetDays).getTime()
}
