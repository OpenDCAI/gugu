import { localDayEndMs, localDayOf, localDayStartMs } from './local-day';

/** 一段「在干活」的时间,半开区间 [startMs, endMs)。 */
export type RunInterval = {
  sessionId: string;
  engine: string;
  startMs: number;
  endMs: number;
};

/**
 * 同一条会话自己的区间先并起来。库里的区间有两路来源(0029 从回合记录回填、recorder 实时记),
 * 相邻两回合也可能首尾相接甚至交叠 —— 不并的话,**同一条会话**会被扫描线当成两条在并行,
 * 运行时长也会把重叠那段算两遍。
 */
export function mergeIntervalsPerSession(intervals: readonly RunInterval[]): RunInterval[] {
  const bySession = new Map<string, RunInterval[]>();
  for (const interval of intervals) {
    if (!(interval.endMs > interval.startMs)) continue;
    const list = bySession.get(interval.sessionId);
    if (list) list.push(interval);
    else bySession.set(interval.sessionId, [interval]);
  }
  const merged: RunInterval[] = [];
  for (const list of bySession.values()) {
    list.sort((a, b) => a.startMs - b.startMs);
    let current = { ...list[0] };
    for (let i = 1; i < list.length; i += 1) {
      const next = list[i];
      if (next.startMs <= current.endMs) {
        current.endMs = Math.max(current.endMs, next.endMs);
      } else {
        merged.push(current);
        current = { ...next };
      }
    }
    merged.push(current);
  }
  return merged;
}

/** 把 [startMs, endMs) 按本地日切开,逐段回调。 */
export function forEachLocalDaySegment(
  startMs: number,
  endMs: number,
  visit: (day: string, segmentMs: number) => void
): void {
  let cursor = startMs;
  while (cursor < endMs) {
    const day = localDayOf(cursor);
    const segmentEnd = Math.min(endMs, localDayEndMs(day));
    visit(day, segmentEnd - cursor);
    cursor = segmentEnd;
  }
}

export function dayEngineKey(day: string, engine: string): string {
  return `${day}\u0000${engine}`;
}

/**
 * (本地日, 引擎) → 在干活的毫秒数。区间先裁到 [from 00:00, to 次日 00:00),跨午夜的按日切开。
 * 多条会话同时在跑时**叠加**(契约:runSeconds 不去重)。
 */
export function runMsByDayEngine(
  intervals: readonly RunInterval[],
  from: string,
  to: string
): Map<string, number> {
  const rangeStart = localDayStartMs(from);
  const rangeEnd = localDayEndMs(to);
  const totals = new Map<string, number>();
  for (const interval of intervals) {
    const start = Math.max(interval.startMs, rangeStart);
    const end = Math.min(interval.endMs, rangeEnd);
    if (!(end > start)) continue;
    forEachLocalDaySegment(start, end, (day, ms) => {
      const key = dayEngineKey(day, interval.engine);
      totals.set(key, (totals.get(key) ?? 0) + ms);
    });
  }
  return totals;
}

export type DeviceDayConcurrency = { parallelMs: number; peakConcurrency: number };

/**
 * 扫描线:每个本地日里「≥2 条会话同时在干活」的毫秒数,以及同时在干活的会话数峰值。
 * 输入应当已经按会话并过(见 {@link mergeIntervalsPerSession}),否则一条会话会和自己并行。
 *
 * 首尾相接(一条 12:00 结束、另一条 12:00 开始)不算并行:同一时刻先减后加。
 * 峰值只看长度 > 0 的时间段 —— 零长度的瞬间不是「同时在干活」。
 */
export function deviceConcurrencyByDay(
  intervals: readonly RunInterval[],
  from: string,
  to: string
): Map<string, DeviceDayConcurrency> {
  const rangeStart = localDayStartMs(from);
  const rangeEnd = localDayEndMs(to);
  const points: Array<{ at: number; delta: number }> = [];
  for (const interval of intervals) {
    const start = Math.max(interval.startMs, rangeStart);
    const end = Math.min(interval.endMs, rangeEnd);
    if (!(end > start)) continue;
    points.push({ at: start, delta: 1 }, { at: end, delta: -1 });
  }
  points.sort((a, b) => a.at - b.at || a.delta - b.delta);

  const byDay = new Map<string, DeviceDayConcurrency>();
  let active = 0;
  for (let i = 0; i < points.length; i += 1) {
    active += points[i].delta;
    const segmentStart = points[i].at;
    const segmentEnd = i + 1 < points.length ? points[i + 1].at : segmentStart;
    if (active <= 0 || !(segmentEnd > segmentStart)) continue;
    forEachLocalDaySegment(segmentStart, segmentEnd, (day, ms) => {
      const entry = byDay.get(day) ?? { parallelMs: 0, peakConcurrency: 0 };
      if (active >= 2) entry.parallelMs += ms;
      if (active > entry.peakConcurrency) entry.peakConcurrency = active;
      byDay.set(day, entry);
    });
  }
  return byDay;
}

/** 本地日界(测试与调用方共用,免得各算一遍)。 */
export function rangeBoundsMs(from: string, to: string): { startMs: number; endMs: number } {
  return { startMs: localDayStartMs(from), endMs: localDayEndMs(to) };
}
