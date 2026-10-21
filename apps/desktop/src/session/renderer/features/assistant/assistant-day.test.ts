import { describe, expect, it } from 'vitest';
import { collapsedRows, dayRows, defaultOpen, eventStatus, isTodayAgenda, joinNow } from './assistant-day';
import type { DayEvent } from './assistant-today-file';

const at = (hhmm: string) => `2026-10-15T${hhmm}:00+08:00`;
const now = Date.parse(at('09:55'));
const event = (over: Partial<DayEvent> & Pick<DayEvent, 'id'>): DayEvent => ({
  title: over.id,
  start: null,
  end: null,
  allDay: false,
  description: '',
  joinUrl: null,
  color: null,
  source: null,
  ...over,
});

describe('eventStatus(按此刻的钟点)', () => {
  it('还早 / 10 分钟内开始 / 进行中 / 10 分钟内结束 / 已过去 / 全天', () => {
    expect(eventStatus(event({ id: 'a', start: at('11:00'), end: at('12:00') }), now)).toEqual({ kind: 'later' });
    expect(eventStatus(event({ id: 'b', start: at('10:05'), end: at('11:00') }), now)).toEqual({ kind: 'soon' });
    expect(eventStatus(event({ id: 'c', start: at('09:00'), end: at('11:00') }), now)).toEqual({ kind: 'now' });
    expect(eventStatus(event({ id: 'd', start: at('09:00'), end: at('10:02') }), now)).toEqual({ kind: 'ending', minutes: 7 });
    expect(eventStatus(event({ id: 'e', start: at('08:00'), end: at('09:00') }), now)).toEqual({ kind: 'past' });
    expect(eventStatus(event({ id: 'f', allDay: true }), now)).toEqual({ kind: 'allDay' });
  });

  it('没写结束时间 = 一个时刻:开始之后就过去了', () => {
    expect(eventStatus(event({ id: 'a', start: at('10:00') }), now)).toEqual({ kind: 'soon' });
    expect(eventStatus(event({ id: 'b', start: at('09:50') }), now)).toEqual({ kind: 'past' });
  });
});

describe('dayRows / defaultOpen / collapsedRows', () => {
  const events = [
    event({ id: 'past-early', start: at('07:00'), end: at('08:00') }),
    event({ id: 'later', start: at('14:00'), end: at('15:00') }),
    event({ id: 'all', allDay: true }),
    event({ id: 'now', start: at('09:30'), end: at('10:30') }),
    event({ id: 'past-late', start: at('09:00'), end: at('09:30') }),
    event({ id: 'soon', start: at('10:00'), end: at('10:40') }),
    event({ id: 'evening', start: at('19:00'), end: at('20:00') }),
  ];

  it('全天在上;还没完的按开始;已过去的最近结束在上', () => {
    const rows = dayRows(events, now);
    expect(rows.allDay.map((e) => e.id)).toEqual(['all']);
    expect(rows.coming.map((e) => e.id)).toEqual(['now', 'soon', 'later', 'evening']);
    expect(rows.past.map((e) => e.id)).toEqual(['past-late', 'past-early']);
    expect(defaultOpen(rows)).toBe('now');
  });

  it('收起:全天 + 最多三行有钟点的,其余数进「再显示 N 项」', () => {
    const { visible, hidden } = collapsedRows(dayRows(events, now));
    expect(visible.allDay.map((e) => e.id)).toEqual(['all']);
    expect(visible.coming.map((e) => e.id)).toEqual(['now', 'soon', 'later']);
    expect(visible.past).toEqual([]);
    expect(hidden).toBe(3);
  });

  it('都过去了:不展开,收起时露最近结束的三行', () => {
    const rows = dayRows(events, Date.parse(at('23:00')));
    expect(defaultOpen(rows)).toBeNull();
    expect(collapsedRows(rows).visible.past.map((e) => e.id)).toEqual(['evening', 'later', 'soon']);
  });
});

describe('joinNow / isTodayAgenda', () => {
  it('快开或正在开、有会议链接才在行上给「加入会议」', () => {
    const meet = event({ id: 'm', start: at('10:00'), end: at('11:00'), joinUrl: 'https://meet.google.com/x' });
    expect(joinNow(meet, eventStatus(meet, now))).toBe(true);
    expect(joinNow(meet, eventStatus(meet, Date.parse(at('08:00'))))).toBe(false);
    expect(joinNow({ ...meet, joinUrl: null }, eventStatus(meet, now))).toBe(false);
  });

  it('它排的不是今天的 = 今天的还没排', () => {
    const today = new Date(2026, 9, 15, 9);
    expect(isTodayAgenda({ localDate: '2026-10-15', updatedAt: null, events: [] }, today)).toBe(true);
    expect(isTodayAgenda({ localDate: '2026-10-14', updatedAt: null, events: [] }, today)).toBe(false);
  });
});
