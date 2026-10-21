import type {
  DeviceDailyUsage,
  EngineDailyUsage,
  LocalUsageSnapshot,
} from '@gugu/core/shared/usage/dailyUsage';
import { localDayOf, localHourOf } from './local-day';
import {
  dayEngineKey,
  deviceConcurrencyByDay,
  mergeIntervalsPerSession,
  runMsByDayEngine,
  type RunInterval,
} from './run-interval-math';
import type { TokenDayRow } from './token-fold';

/** 会话行里 provider 为空时的引擎名(老数据)。 */
export const UNKNOWN_ENGINE = 'unknown';


export type LocalUsageInputs = {
  from: string;
  to: string;
  /** 每条会话一项:引擎与创建时刻。 */
  sessions: ReadonlyArray<{ engine: string; createdAtMs: number }>;
  /** 已解析好终点的区间(还开着的由调用方按 now 收)。 */
  intervals: readonly RunInterval[];
  /** 已去重、已按「引擎 × 本地日 × 模型」求和的 token(见 token-fold.ts,在 worker 里算好)。 */
  tokenRows: readonly TokenDayRow[];
};

/**
 * 纯汇总:把会话、运行区间、token 条目按「本地日 × 引擎」合成契约里的快照。
 * 只输出至少有一项非零的行 —— 云端按行 upsert,全零行没有信息。
 */
export function combineLocalUsage(input: LocalUsageInputs): LocalUsageSnapshot {
  const { from, to } = input;
  const inRange = (day: string) => day >= from && day <= to;
  const rows = new Map<string, EngineDailyUsage>();
  const rowFor = (day: string, engine: string): EngineDailyUsage => {
    const key = dayEngineKey(day, engine);
    let row = rows.get(key);
    if (!row) {
      row = {
        day,
        engine,
        sessions: 0,
        runSeconds: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        models: {},
        guguModels: {},
        byokModels: {},
        hours: new Array<number>(24).fill(0),
      };
      rows.set(key, row);
    }
    return row;
  };

  for (const session of input.sessions) {
    const day = localDayOf(session.createdAtMs);
    if (!inRange(day)) continue;
    const row = rowFor(day, session.engine);
    row.sessions += 1;
    row.hours[localHourOf(session.createdAtMs)] += 1;
  }

  const merged = mergeIntervalsPerSession(input.intervals);
  for (const [key, ms] of runMsByDayEngine(merged, from, to)) {
    const [day, engine] = key.split('\u0000');
    const seconds = Math.round(ms / 1000);
    if (seconds > 0) rowFor(day, engine).runSeconds += seconds;
  }

  for (const token of input.tokenRows) {
    if (!inRange(token.day)) continue;
    const row = rowFor(token.day, token.provider);
    row.inputTokens += token.input;
    row.outputTokens += token.output;
    row.cacheReadTokens += token.cacheRead;
    row.cacheWriteTokens += token.cacheWrite;
    const tokens = token.input + token.output + token.cacheRead + token.cacheWrite;
    row.models[token.model] = (row.models[token.model] ?? 0) + tokens;
    // 分来源的那两份只收说得清的;说不清的只进总数(用量页显示为「未区分」)。
    if (token.source === 'gugu') row.guguModels[token.model] = (row.guguModels[token.model] ?? 0) + tokens;
    if (token.source === 'byok') row.byokModels[token.model] = (row.byokModels[token.model] ?? 0) + tokens;
  }

  const device: DeviceDailyUsage[] = [];
  for (const [day, value] of deviceConcurrencyByDay(merged, from, to)) {
    device.push({
      day,
      parallelSeconds: Math.round(value.parallelMs / 1000),
      peakConcurrency: value.peakConcurrency,
    });
  }

  const engines = [...rows.values()].sort((a, b) =>
    a.day === b.day ? a.engine.localeCompare(b.engine) : a.day < b.day ? -1 : 1
  );
  device.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  return { from, to, engines, device };
}
