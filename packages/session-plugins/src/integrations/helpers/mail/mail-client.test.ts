import { describe, expect, it } from 'vitest';
import { parseDay } from './mail-client';

/**
 * imapflow 写 SINCE / BEFORE 用的是 UTC 的年月日(`toISOString().substring(0, 10)`)。
 * 本地零点在东八区是前一天的 16:00Z ⇒ 查「10-15 以来」会被写成 14-Oct。这里钉住:给出去的是 UTC 零点。
 */
describe('parseDay', () => {
  it('YYYY-MM-DD → 那一天的 UTC 零点(imapflow 写出来就是这一天)', () => {
    expect(parseDay('2026-10-15', 'since').toISOString()).toBe('2026-10-15T00:00:00.000Z');
  });

  it('不是 YYYY-MM-DD → 说清楚要什么格式', () => {
    expect(() => parseDay('10/15', 'since')).toThrow(/since must be a date like 2026-10-15/);
    expect(() => parseDay('2026-10-15T08:00', 'before')).toThrow(/before must be a date/);
  });
});
