/**
 * day-boundary — 日历日的划分与命名。
 *
 * # 为什么格式化规则不是在这里新发明的
 *
 * React chrome 面已经有 `apps/desktop/src/session/renderer/lib/ui/absolute-time.tsx`，
 * 它用 date-fns 的 `MMM d, HH:mm`（跨年时 `MMM d yyyy, HH:mm`）显示绝对时刻。
 * 那个 pattern 在逗号处天然分成两半：**日期**半边和**时刻**半边。日界分隔行要的正是
 * 日期那半边，所以这里用的是同一个库、同一组 token、同一条跨年判据
 * （`date.getFullYear() !== new Date().getFullYear()` 才带年份）——
 * 于是同一天在 transcript 里和在 React chrome 里读出来是同一个字符串，
 * 而不是两套各自演化的写法。
 *
 * 相对/绝对怎么切也沿用同一面的语义：`relative-time.tsx` 用相对说法表达"离现在很近"，
 * `absolute-time.tsx` 用绝对日期表达"具体是哪天"。日界只有两个"离现在很近"的取值
 * ——今天、昨天——它们经 translator 出文案；再往前一律退回绝对日期。
 *
 * ⚠️ 这里所有函数都按**本地时区**算。日界是读者眼里的日界，不是 UTC 的。
 */

import { format } from 'date-fns';
import type { ChatTranslator } from '../localization';

const MS_PER_DAY = 86_400_000;

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

/** 该时刻所在本地日的零点（epoch ms）。 */
function startOfLocalDay(epochMs: number): number {
  const d = new Date(epochMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * `then` 比 `now` 早几个日历日。同一天为 0，昨天为 1。
 *
 * 取两个本地零点之差再 `round`：夏令时的那两天真实长度是 23h / 25h，
 * 直接除以 86400000 再取整会把它们算成 0.96 天或 1.04 天。
 */
function calendarDaysBefore(then: number, now: number): number {
  return Math.round((startOfLocalDay(now) - startOfLocalDay(then)) / MS_PER_DAY);
}

/**
 * 日界分隔行上显示的那句话。
 *
 * 今天 / 昨天走 translator；再往前用与 `absolute-time.tsx` 逐字相同的日期 pattern。
 * `now` 由调用方传进来（而不是在这里读 `Date.now()`），因为这个函数是纯的：
 * 组件负责在跨过午夜时把新的 `now` 喂回来，测试负责钉住一个确定的"现在"。
 */
export function dayBoundaryLabel(startedAt: number, now: number, translate: ChatTranslator): string {
  const delta = calendarDaysBefore(startedAt, now);
  if (delta === 0) return translate('transcript.today');
  if (delta === 1) return translate('transcript.yesterday');

  const date = new Date(startedAt);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return format(date, sameYear ? 'MMM d' : 'MMM d yyyy');
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
