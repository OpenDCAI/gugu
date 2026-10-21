import { describe, expect, it } from 'vitest';
import {
  enumerateLocalDays,
  isLocalDay,
  localDayEndMs,
  localDayOf,
  localDayStartMs,
  sqliteTextToMs,
} from './local-day';
import {
  deviceConcurrencyByDay,
  mergeIntervalsPerSession,
  runMsByDayEngine,
  type RunInterval,
} from './run-interval-math';
import { validateLocalUsageRequest } from './validate-request';

// 所有时刻都用本地时区的 Date 构造:判据跟着进程时区走,在哪台机器上跑都成立。
const at = (day: number, hour: number, minute = 0) => new Date(2026, 8, day, hour, minute).getTime();
const MIN = 60_000;

function interval(sessionId: string, engine: string, startMs: number, endMs: number): RunInterval {
  return { sessionId, engine, startMs, endMs };
}

describe('local-day', () => {
  it('本地日与日界互相对得上', () => {
    expect(localDayOf(at(23, 0, 0))).toBe('2026-09-23');
    expect(localDayOf(at(23, 23, 59))).toBe('2026-09-23');
    expect(localDayStartMs('2026-09-23')).toBe(at(23, 0));
    expect(localDayEndMs('2026-09-23')).toBe(at(24, 0));
    expect(enumerateLocalDays('2026-09-29', '2026-10-02')).toEqual([
      '2026-09-29',
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
    ]);
  });

  it('只认真实存在的 YYYY-MM-DD', () => {
    expect(isLocalDay('2026-09-23')).toBe(true);
    expect(isLocalDay('2026-02-30')).toBe(false);
    expect(isLocalDay('2026-9-23')).toBe(false);
    expect(isLocalDay(20260923)).toBe(false);
  });

  it('SQLite 的 UTC 文本与 ISO 串都认', () => {
    expect(sqliteTextToMs('2026-09-23 17:20:01')).toBe(Date.UTC(2026, 8, 23, 17, 20, 1));
    expect(sqliteTextToMs('2026-09-23T17:20:01.000Z')).toBe(Date.UTC(2026, 8, 23, 17, 20, 1));
    expect(sqliteTextToMs('garbage')).toBeNull();
    expect(sqliteTextToMs(null)).toBeNull();
  });

  it('夏令时切换日按真实的日界切,不是 24 小时', () => {
    // 找一个本地时区里不是 24 小时的日子;本机时区没有夏令时就没有这种日子,这条自然不适用。
    const odd = enumerateLocalDays('2026-01-01', '2026-12-31').find(
      (day) => localDayEndMs(day) - localDayStartMs(day) !== 24 * 60 * MIN
    );
    if (!odd) return;
    const length = localDayEndMs(odd) - localDayStartMs(odd);
    const whole = runMsByDayEngine(
      [interval('c', 'claude', localDayStartMs(odd) - MIN, localDayEndMs(odd) + MIN)],
      odd,
      odd
    );
    expect([...whole.values()]).toEqual([length]);
  });
});

describe('mergeIntervalsPerSession', () => {
  it('同一条会话交叠/相接的区间并成一段,不同会话互不影响', () => {
    const merged = mergeIntervalsPerSession([
      interval('a', 'claude', at(23, 10), at(23, 11)),
      interval('a', 'claude', at(23, 10, 30), at(23, 12)),
      interval('a', 'claude', at(23, 12), at(23, 12, 30)),
      interval('a', 'claude', at(23, 14), at(23, 15)),
      interval('b', 'codex', at(23, 10), at(23, 11)),
      interval('b', 'codex', at(23, 11), at(23, 11)), // 零长度丢掉
    ]);
    const a = merged.filter((i) => i.sessionId === 'a').map((i) => [i.startMs, i.endMs]);
    expect(a).toEqual([
      [at(23, 10), at(23, 12, 30)],
      [at(23, 14), at(23, 15)],
    ]);
    expect(merged.filter((i) => i.sessionId === 'b')).toHaveLength(1);
  });
});

describe('runMsByDayEngine', () => {
  it('跨午夜的区间按本地日切开,范围外的部分裁掉', () => {
    const totals = runMsByDayEngine(
      [
        interval('a', 'claude', at(22, 23, 0), at(23, 1, 0)), // 22 日 60 分 + 23 日 60 分
        interval('b', 'claude', at(23, 9, 0), at(23, 9, 30)),
        interval('c', 'codex', at(24, 23, 30), at(25, 0, 30)), // 25 日那半截在范围外
      ],
      '2026-09-23',
      '2026-09-24'
    );
    expect(Object.fromEntries(totals)).toEqual({
      '2026-09-23\u0000claude': 90 * MIN,
      '2026-09-24\u0000codex': 30 * MIN,
    });
  });

  it('多条会话同时在跑时叠加(契约:runSeconds 不去重)', () => {
    const totals = runMsByDayEngine(
      [interval('a', 'claude', at(23, 10), at(23, 11)), interval('b', 'claude', at(23, 10), at(23, 11))],
      '2026-09-23',
      '2026-09-23'
    );
    expect(totals.get('2026-09-23\u0000claude')).toBe(120 * MIN);
  });
});

describe('deviceConcurrencyByDay', () => {
  it('并行时长 = ≥2 条同时在跑的时长,峰值取当天最大并发', () => {
    const byDay = deviceConcurrencyByDay(
      [
        interval('a', 'claude', at(23, 10), at(23, 12)),
        interval('b', 'codex', at(23, 11), at(23, 13)),
        interval('c', 'claude', at(23, 11, 30), at(23, 11, 45)),
      ],
      '2026-09-23',
      '2026-09-23'
    );
    // 11:00–12:00 至少两条 = 60 分钟;11:30–11:45 三条。
    expect(byDay.get('2026-09-23')).toEqual({ parallelMs: 60 * MIN, peakConcurrency: 3 });
  });

  it('首尾相接不算并行,峰值是 1', () => {
    const byDay = deviceConcurrencyByDay(
      [interval('a', 'claude', at(23, 10), at(23, 11)), interval('b', 'claude', at(23, 11), at(23, 12))],
      '2026-09-23',
      '2026-09-23'
    );
    expect(byDay.get('2026-09-23')).toEqual({ parallelMs: 0, peakConcurrency: 1 });
  });

  it('跨午夜的并行按日拆,两天各有自己的峰值', () => {
    const byDay = deviceConcurrencyByDay(
      [
        interval('a', 'claude', at(22, 23), at(23, 1)),
        interval('b', 'codex', at(22, 23, 30), at(23, 0, 30)),
      ],
      '2026-09-22',
      '2026-09-23'
    );
    expect(byDay.get('2026-09-22')).toEqual({ parallelMs: 30 * MIN, peakConcurrency: 2 });
    expect(byDay.get('2026-09-23')).toEqual({ parallelMs: 30 * MIN, peakConcurrency: 2 });
  });

  it('没有区间就没有行', () => {
    expect(deviceConcurrencyByDay([], '2026-09-23', '2026-09-23').size).toBe(0);
  });
});

describe('validateLocalUsageRequest', () => {
  it('合法范围放行', () => {
    expect(validateLocalUsageRequest({ from: '2026-09-01', to: '2026-09-23' })).toBeNull();
    expect(validateLocalUsageRequest({ from: '2025-09-23', to: '2026-09-23' })).toBeNull();
  });

  it('倒置、格式错、超过 400 天都拒', () => {
    expect(validateLocalUsageRequest({ from: '2026-09-24', to: '2026-09-23' })).toMatch(/after/);
    expect(validateLocalUsageRequest({ from: '2026/09/01', to: '2026-09-23' })).toMatch(/from/);
    expect(validateLocalUsageRequest({ from: '2025-01-01', to: '2026-09-23' })).toMatch(/max 400/);
    expect(validateLocalUsageRequest({ from: '2020-01-01', to: '2026-09-23' })).toMatch(/exceeds/);
    expect(validateLocalUsageRequest(null)).toMatch(/request/);
  });
});
