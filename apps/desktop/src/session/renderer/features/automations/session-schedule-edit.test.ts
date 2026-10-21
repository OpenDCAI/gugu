import { describe, expect, it } from 'vitest';
import {
  cronTrigger,
  fromLocalInputValue,
  oneTimeTrigger,
  timeOfDayOf,
  toLocalInputValue,
  tomorrowNine,
  withTimeOfDay,
} from './session-schedule-edit';

describe('改时间:一次性', () => {
  it('本地时间串来回不丢分钟', () => {
    const at = new Date(2026, 9, 19, 10, 30).getTime();
    expect(toLocalInputValue(at)).toBe('2026-10-19T10:30');
    expect(fromLocalInputValue('2026-10-19T10:30')).toBe(at);
    expect(fromLocalInputValue('')).toBeNull();
  });
  it('只换那一刻,tz 原样', () => {
    expect(oneTimeTrigger({ expr: '', tz: 'Asia/Shanghai', at: 1 }, 2)).toEqual({ expr: '', tz: 'Asia/Shanghai', at: 2 });
  });
  it('明早 9 点是本地的明天 09:00', () => {
    expect(tomorrowNine(new Date(2026, 9, 19, 23, 50).getTime())).toBe(new Date(2026, 9, 20, 9, 0).getTime());
  });
});

describe('改时间:重复的', () => {
  it.each([
    ['0 9 * * 1-5', '09:00'],
    ['30 8 * * *', '08:30'],
    ['0 18 * * 5', '18:00'],
    // 改不了「几点」的,整条规则改。
    ['*/15 * * * *', null],
    ['0 9 1 * *', null],
  ])('%s → %s', (expr, time) => {
    expect(timeOfDayOf(expr)).toBe(time);
  });
  it('只换几点,星期那一段原样;tz 原样', () => {
    expect(withTimeOfDay('0 9 * * 1-5', '10:30')).toBe('30 10 * * 1-5');
    // 时刻框被清空:不拼 NaN,交给保存钮灰掉。
    expect(withTimeOfDay('0 9 * * 1-5', '')).toBeNull();
    expect(cronTrigger({ expr: '0 9 * * 1-5', tz: 'Asia/Shanghai' }, ' 30 10 * * 1-5 ')).toEqual({ expr: '30 10 * * 1-5', tz: 'Asia/Shanghai' });
  });
});
