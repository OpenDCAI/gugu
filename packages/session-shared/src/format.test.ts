import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  differenceInCalendarDays,
  formatCalendarDate,
  formatRelativeTime,
  formatRelativeTimeParts,
  toLocalDateTimeInput,
  type RelativeTimeOptions,
  type RelativeTimeWords,
} from './format';

const nowMs = new Date(2026, 0, 15, 12).getTime();
const words: RelativeTimeWords = {
  now: 'NOW',
  elapsed: (count, unit) => `${count}:${unit}:elapsed`,
  compact: (count, unit) => `${count}:${unit}`,
};
const label = (offset: number, options: RelativeTimeOptions) =>
  formatRelativeTime(nowMs + offset, 'en-US', words, { ...options, nowMs });

describe('relative-time modes', () => {
  it('keeps the app elapsed thresholds and clamps future times to now', () => {
    expect(label(-59_999, { mode: 'elapsed' })).toBe('NOW');
    expect(label(60_000, { mode: 'elapsed' })).toBe('NOW');
    expect(label(-60_000, { mode: 'elapsed' })).toBe('1:minute:elapsed');
    expect(label(-3_600_000, { mode: 'elapsed' })).toBe('1:hour:elapsed');
    expect(label(-86_400_000, { mode: 'elapsed' })).toBe('1:day:elapsed');
    expect(label(-30 * 86_400_000, { mode: 'elapsed', dateAfterDays: 30 })).toBe('Dec 16');
  });

  it('rounds strict distances, floors compact distances, and retains future direction', () => {
    expect(label(-90_000, { mode: 'strict' })).toBe('2 minutes ago');
    expect(label(90_000, { mode: 'strict' })).toBe('in 2 minutes');
    expect(label(-90_000, { mode: 'compact' })).toBe('1:minute');
    expect(label(90_000, { mode: 'compact', addSuffix: true })).toBe('NOW');
    expect(label(-30_000, { mode: 'strict', addSuffix: false })).toBe('30 seconds');
    expect(label(-59_999, { mode: 'compact' })).toBe('NOW');
    expect(label(-60_000, { mode: 'compact' })).toBe('1:minute');
    expect(label(-30 * 86_400_000, { mode: 'strict' })).toBe('1 month ago');
    expect(label(-365 * 86_400_000, { mode: 'strict' })).toBe('1 year ago');
  });

  it('gets Chinese text and directional literal parts from Intl', () => {
    const parts = formatRelativeTimeParts(nowMs - 180_000, 'zh-CN', words, { mode: 'compact', addSuffix: true, nowMs });
    expect(parts.map((part) => part.value).join('')).toBe('3分钟前');
    expect(parts.filter((part) => part.type === 'suffix').map((part) => part.value).join('')).toBe('分钟前');
    expect(formatRelativeTime(nowMs + 180_000, 'zh-CN', words, { mode: 'strict', nowMs })).toBe('3分钟后');
  });
});

describe('local calendar and datetime-local values across DST', () => {
  const previousTimezone = process.env.TZ;
  beforeAll(() => { process.env.TZ = 'America/New_York'; });
  afterAll(() => {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  });

  it.each([[2026, 2, 8, 23], [2026, 10, 1, 25]])('counts a %i-%i-%i local day once', (year, month, day, hours) => {
    const start = new Date(year, month, day);
    const next = new Date(year, month, day + 1);
    expect((next.getTime() - start.getTime()) / 3_600_000).toBe(hours);
    expect(differenceInCalendarDays(next, start)).toBe(1);
    expect(formatRelativeTime(start.getTime(), 'en-US', words, { mode: 'strict', nowMs: next.getTime() + 3_600_000 })).toBe('1 day ago');
  });

  it('round trips local input fields and shares year-aware absolute date text', () => {
    const date = new Date(2026, 9, 15, 7, 7);
    expect(toLocalDateTimeInput(date)).toBe('2026-10-15T07:07');
    expect(new Date(toLocalDateTimeInput(date)).getTime()).toBe(date.getTime());
    expect(formatCalendarDate(date, 'zh-CN', { now: date })).toBe('10月15日 07:07');
    expect(formatCalendarDate(date, 'en-US', { now: date })).toBe('Oct 15, 07:07');
    expect(formatCalendarDate(date, 'zh-CN', { now: new Date(2027, 0), includeTime: false })).toBe('2026年10月15日');
  });
});
