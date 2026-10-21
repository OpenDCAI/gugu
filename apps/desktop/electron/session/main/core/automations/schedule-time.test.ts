import { describe, expect, it } from 'vitest';
import { describeScheduleTime, MIN_ONE_TIME_LEAD_MS, resolveScheduleTrigger } from './schedule-time';

// 2026-10-15 06:00 北京时间
const NOW = Date.UTC(2026, 9, 14, 22, 0, 0);

describe('resolveScheduleTrigger (#7221)', () => {
  it('一次性:不带偏移的时刻按 tz 读,带偏移的按偏移读', () => {
    expect(resolveScheduleTrigger({ at: '2026-10-16T08:00', tz: 'Asia/Shanghai' }, NOW)).toEqual({
      expr: '',
      tz: 'Asia/Shanghai',
      at: Date.UTC(2026, 9, 16, 0, 0, 0),
    });
    expect(resolveScheduleTrigger({ at: '2026-10-16T08:00:00Z', tz: 'Asia/Shanghai' }, NOW).at).toBe(
      Date.UTC(2026, 9, 16, 8, 0, 0)
    );
    expect(resolveScheduleTrigger({ at: '2026-10-16T08:00+09:00', tz: 'Asia/Shanghai' }, NOW).at).toBe(
      Date.UTC(2026, 9, 15, 23, 0, 0)
    );
  });

  it('重复:原样存 cron 与 tz', () => {
    expect(resolveScheduleTrigger({ cron: '0 8 * * *', tz: 'Asia/Shanghai' }, NOW)).toEqual({
      expr: '0 8 * * *',
      tz: 'Asia/Shanghai',
    });
  });

  it('过去的、不足一分钟的一次性当场拒,并说清现在几点', () => {
    expect(() => resolveScheduleTrigger({ at: '2026-10-15T05:59', tz: 'Asia/Shanghai' }, NOW)).toThrow(
      /2026-10-15 05:59 Asia\/Shanghai has already passed; it is now 2026-10-15 06:00 Asia\/Shanghai/
    );
    expect(() =>
      resolveScheduleTrigger({ at: '2026-10-15T06:00:30', tz: 'Asia/Shanghai' }, NOW)
    ).toThrow(/less than a minute from now/);
    // 边界:正好一分钟收下(阴控:上面那条不是因为一切一次性都被拒)。
    expect(
      resolveScheduleTrigger({ at: '2026-10-15T06:01', tz: 'Asia/Shanghai' }, NOW).at
    ).toBe(NOW + MIN_ONE_TIME_LEAD_MS);
  });

  it('参数错一律说清改成什么样', () => {
    expect(() => resolveScheduleTrigger({ tz: 'Asia/Shanghai' }, NOW)).toThrow(/exactly one of at/);
    expect(() =>
      resolveScheduleTrigger({ at: '2026-10-16T08:00', cron: '0 8 * * *' }, NOW)
    ).toThrow(/exactly one of at/);
    expect(() => resolveScheduleTrigger({ cron: 'every day at 8' }, NOW)).toThrow(/5-field cron/);
    expect(() => resolveScheduleTrigger({ at: 'tomorrow 8am' }, NOW)).toThrow(/ISO 8601/);
    expect(() => resolveScheduleTrigger({ at: '2026-13-45T08:00' }, NOW)).toThrow(/not a real date-time/);
    expect(() => resolveScheduleTrigger({ cron: '0 8 * * *', tz: 'Mars/Base' }, NOW)).toThrow(
      /unknown time zone "Mars\/Base"/
    );
  });

  it('describeScheduleTime 读的是那个时区里的日期与时刻', () => {
    expect(describeScheduleTime(Date.UTC(2026, 9, 15, 17, 30), 'Asia/Shanghai')).toBe(
      '2026-10-16 01:30 Asia/Shanghai'
    );
    expect(describeScheduleTime(Date.UTC(2026, 9, 15, 17, 30), 'UTC')).toBe('2026-10-15 17:30 UTC');
  });
});
