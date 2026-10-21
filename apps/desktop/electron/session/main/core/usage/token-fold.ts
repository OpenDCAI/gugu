import { localDayOf } from './local-day';
import { sourceAt, type ModelSource, type SourceSpans } from './model-source';
import type { ProviderTokenEntry } from './token-scan';

/** 一家引擎、一个本地日、一个模型的 token 合计。worker 交回主进程的就是这个(量级:天 × 引擎 × 模型)。 */
export type TokenDayRow = {
  provider: string;
  day: string;
  model: string;
  /** 咕咕模型 / 自己账号;null = 说不清(见 model-source.ts)。 */
  source: ModelSource | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

const QUARTER_HOUR_MS = 15 * 60_000;

/**
 * 全局去重 + 按「引擎 × 本地日 × 模型 × 来源」求和。纯函数。
 *
 * 来源:按条目所属会话在那一刻的来源(sourcesBySession,见 model-source.ts)。
 *
 * 去重:同一次请求会出现在多行(claude 一条消息按内容块写多行)、多份文件里(分叉/续接复制历史),
 * 同一家引擎内按条目的 key 只算一次;不同引擎的 key 互不相干。
 *
 * 归天:十万级条目逐条 new Date 太贵,按 15 分钟一桶记住「这一桶是哪天」。所有时区偏移
 * (含 +5:45、+8:45)都是 15 分钟的整数倍,夏令时切换也落在整刻,所以同一桶内不会跨本地日。
 * 时区是运行它的线程所在进程的本地时区(worker 线程与主线程共用 process.env.TZ)。
 */
export function foldTokenEntries(
  entries: readonly ProviderTokenEntry[],
  sourcesByProviderSession: Readonly<Record<string, SourceSpans>> = {}
): TokenDayRow[] {
  const dayByBucket = new Map<number, string>();
  const dayOf = (ts: number): string => {
    const bucket = Math.floor(ts / QUARTER_HOUR_MS);
    let day = dayByBucket.get(bucket);
    if (day === undefined) {
      day = localDayOf(bucket * QUARTER_HOUR_MS);
      dayByBucket.set(bucket, day);
    }
    return day;
  };

  const seenByProvider = new Map<string, Set<string>>();
  const rows = new Map<string, TokenDayRow>();
  for (const entry of entries) {
    let seen = seenByProvider.get(entry.provider);
    if (!seen) {
      seen = new Set();
      seenByProvider.set(entry.provider, seen);
    }
    if (seen.has(entry.key)) continue;
    seen.add(entry.key);

    const day = dayOf(entry.ts);
    const source = sourceAt(sourcesByProviderSession[entry.providerSessionId], entry.ts);
    const key = `${entry.provider}\u0000${day}\u0000${entry.model}\u0000${source ?? ''}`;
    let row = rows.get(key);
    if (!row) {
      row = { provider: entry.provider, day, model: entry.model, source, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      rows.set(key, row);
    }
    row.input += entry.input;
    row.output += entry.output;
    row.cacheRead += entry.cacheRead;
    row.cacheWrite += entry.cacheWrite;
  }
  return [...rows.values()];
}
