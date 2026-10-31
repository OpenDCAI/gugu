/** Local calendar day keys and midnight scheduling; host supplies display locale and translations. */
import { differenceInCalendarDays, formatCalendarDate, type SupportedLocale } from '@gugu/session-shared/format';
import type { ChatTranslator } from '../localization';

/**
 * 一个时刻所属本地日历日的稳定键（`YYYY-MM-DD`）。
 *
 * 只用来判"是不是同一天"，不进 UI。用本地年月日拼串而不是 `toISOString().slice(0,10)`：
 * 后者是 UTC 的日，会让 UTC+8 的深夜和 UTC-5 的清晨落到错误的一侧。
 */
export function localDayKey(epochMs: number): string {
  const d = new Date(epochMs);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

/**
 * 日界分隔行上显示的那句话。
 *
 * 今天 / 昨天走 translator；再往前与 React chrome 共用显式 locale 的绝对日期。
 * `now` 由调用方传进来（而不是在这里读 `Date.now()`），因为这个函数是纯的：
 * 组件负责在跨过午夜时把新的 `now` 喂回来，测试负责钉住一个确定的"现在"。
 */
export function dayBoundaryLabel(startedAt: number, now: number, translate: ChatTranslator, locale: SupportedLocale): string {
  const delta = differenceInCalendarDays(now, startedAt);
  if (delta === 0) return translate('transcript.today');
  if (delta === 1) return translate('transcript.yesterday');

  return formatCalendarDate(startedAt, locale, { includeTime: false, now: new Date(now) });
}

/**
 * 从 `now` 到下一个本地午夜的毫秒数（至少 1，避免 0 造成的忙循环）。
 *
 * 分隔行用它安排一次性定时器：一个开着不动的窗口跨过午夜时，
 * "今天"必须变成"昨天"，否则这一行会安静地开始说假话。
 */
export function msUntilNextLocalMidnight(now: number): number {
  const next = new Date(now);
  next.setHours(0, 0, 0, 0);
  // ❌ 不写 `+ MS_PER_DAY`：夏令时的那两天是 23h / 25h，加满 24h 会落到午夜的错误一侧。
  // `setDate(+1)` 走的是日历加法，Date 自己处理跨月、跨年与 DST，落点仍是本地零点。
  next.setDate(next.getDate() + 1);
  return Math.max(1, next.getTime() - now);
}
