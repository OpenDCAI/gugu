// #7199 「动态」页「日程进展」那一张怎么排、每一行此刻是什么状态:纯函数,单测在 assistant-day.test.ts。
// 事件是它写在 today.json 里的(assistant-today-file.ts),「即将开始 / 进行中 / N 分钟后结束 / 已过去」按这台设备此刻的钟点算。
import { dayOf, type DayEvent, type TodayDay } from './assistant-today-file';

/** 「即将开始」「N 分钟后结束」的窗口(10 分钟)。 */
export const SOON_MS = 10 * 60_000;
/** 收起时最多露几行有钟点的(全天的另算)。 */
export const COLLAPSED_TIMED = 3;

export type EventStatus =
  | { kind: 'allDay' }
  | { kind: 'later' }
  | { kind: 'soon' }
  | { kind: 'now' }
  | { kind: 'ending'; minutes: number }
  | { kind: 'past' };

const at = (iso: string | null): number | null => (iso === null ? null : Date.parse(iso));

/** 一件事此刻的状态。没写结束时间的 = 一个时刻:开始之后就算过去了。 */
export function eventStatus(event: DayEvent, now: number): EventStatus {
  if (event.allDay) return { kind: 'allDay' };
  const start = at(event.start) ?? now;
  const end = at(event.end);
  if (end === null) {
    if (now >= start) return { kind: 'past' };
    return start - now <= SOON_MS ? { kind: 'soon' } : { kind: 'later' };
  }
  if (now >= end) return { kind: 'past' };
  if (now < start) return start - now <= SOON_MS ? { kind: 'soon' } : { kind: 'later' };
  const left = end - now;
  return left <= SOON_MS ? { kind: 'ending', minutes: Math.max(1, Math.ceil(left / 60_000)) } : { kind: 'now' };
}

export type DayRows = { allDay: DayEvent[]; coming: DayEvent[]; past: DayEvent[] };

/** 排法:全天的在上;还没完的按开始时间;一条「已过去」;已结束的、最近结束的在上。 */
export function dayRows(events: readonly DayEvent[], now: number): DayRows {
  const allDay = events.filter((event) => event.allDay);
  const timed = events.filter((event) => !event.allDay);
  const coming = timed.filter((event) => eventStatus(event, now).kind !== 'past').sort((a, b) => (at(a.start) ?? 0) - (at(b.start) ?? 0));
  const ended = (event: DayEvent) => at(event.end) ?? at(event.start) ?? 0;
  const past = timed.filter((event) => eventStatus(event, now).kind === 'past').sort((a, b) => ended(b) - ended(a));
  return { allDay, coming, past };
}

/** 默认展开哪一行:第一件还没完的有钟点的事;都过去了 = 不展开。 */
export function defaultOpen(rows: DayRows): string | null {
  return rows.coming[0]?.id ?? null;
}

/** 收起时露出来的行(全天的 + 最多三行有钟点的)与收进「再显示 N 项」的个数。 */
export function collapsedRows(rows: DayRows): { visible: DayRows; hidden: number } {
  const coming = rows.coming.slice(0, COLLAPSED_TIMED);
  const past = rows.past.slice(0, Math.max(0, COLLAPSED_TIMED - coming.length));
  return { visible: { allDay: rows.allDay, coming, past }, hidden: rows.coming.length + rows.past.length - coming.length - past.length };
}

/** 快开或正在开、又有会议链接的:行上直接给「加入会议」(不用先点开)。 */
export function joinNow(event: DayEvent, status: EventStatus): boolean {
  return !!event.joinUrl && (status.kind === 'soon' || status.kind === 'now' || status.kind === 'ending');
}

/** 它排的是不是今天的;不是 = 今天的还没排(❌ 把昨天的当今天画)。 */
export function isTodayAgenda(day: TodayDay, now: Date): boolean {
  return dayOf(day.localDate, now) === 'today';
}
