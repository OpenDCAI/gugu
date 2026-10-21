/**
 * 用量页的「天」= 产生数据那台设备的**本地日历日**(packages/core/src/shared/usage/dailyUsage.ts 的抬头)。
 * 这里是主进程这侧「毫秒 ↔ 本地日」的唯一换算,时区取进程本地时区(Date 的本地 getter)。
 *
 * ⚠️ 一天不一定是 24 小时(夏令时切换日 23 / 25 小时)⇒ 日界一律由 `new Date(y, m, d)` 算,❌ 不拿 86400000 去加。
 */

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function formatLocalDate(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** YYYY-MM-DD 且是真实存在的日期(2026-02-30 不算)。 */
export function isLocalDay(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = DAY_PATTERN.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

function parseDay(day: string): Date {
  const match = DAY_PATTERN.exec(day);
  if (!match) throw new Error(`not a YYYY-MM-DD day: ${day}`);
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/** 这一毫秒落在哪个本地日。 */
export function localDayOf(ms: number): string {
  return formatLocalDate(new Date(ms));
}

/** 这一毫秒的本地钟点(0–23)。 */
export function localHourOf(ms: number): number {
  return new Date(ms).getHours();
}

/** 本地日 00:00 的 epoch 毫秒。 */
export function localDayStartMs(day: string): number {
  return parseDay(day).getTime();
}

export function nextLocalDay(day: string): string {
  const date = parseDay(day);
  return formatLocalDate(new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1));
}

/** 下一个本地日 00:00 的 epoch 毫秒(= 这一天的开区间终点)。 */
export function localDayEndMs(day: string): number {
  return localDayStartMs(nextLocalDay(day));
}

/** from..to(含)逐日列出。 */
export function enumerateLocalDays(from: string, to: string): string[] {
  const days: string[] = [];
  for (let day = from; day <= to; day = nextLocalDay(day)) days.push(day);
  return days;
}

/**
 * SQLite `CURRENT_TIMESTAMP` 落的是 `YYYY-MM-DD HH:MM:SS`(UTC、无时区标记);我们自己写回的字段
 * (`updated_at` 在 restart 里、`last_interacted_at`)是 ISO 串。两种都认;认不出返回 null。
 */
export function sqliteTextToMs(text: string | null | undefined): number | null {
  if (!text) return null;
  const raw = text.trim();
  if (!raw) return null;
  const normalized = /[TZ+]/.test(raw) ? raw : `${raw.replace(' ', 'T')}Z`;
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? null : ms;
}
