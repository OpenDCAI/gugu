import { describe, expect, it } from 'vitest';
import { combineLocalUsage } from './combine-local-usage';
import { sourceAt } from './model-source';
import { foldTokenEntries } from './token-fold';
import type { ProviderTokenEntry } from './token-scan';

const at = (day: number, hour: number, minute = 0) => new Date(2026, 8, day, hour, minute).getTime();

function token(provider: string, key: string, ts: number, model: string, n: number): ProviderTokenEntry {
  return { provider, providerSessionId: 's1', key, ts, model, input: n, output: n, cacheRead: n, cacheWrite: n };
}

describe('combineLocalUsage', () => {
  it('会话数与钟点分布按创建时刻归本地日;范围外的不计', () => {
    const snapshot = combineLocalUsage({
      from: '2026-09-23',
      to: '2026-09-23',
      sessions: [
        { engine: 'claude', createdAtMs: at(23, 9, 5) },
        { engine: 'claude', createdAtMs: at(23, 9, 50) },
        { engine: 'codex', createdAtMs: at(23, 21) },
        { engine: 'claude', createdAtMs: at(22, 23, 59) },
      ],
      intervals: [],
      tokenRows: [],
    });
    expect(snapshot.engines.map((row) => [row.engine, row.sessions])).toEqual([
      ['claude', 2],
      ['codex', 1],
    ]);
    const claude = snapshot.engines[0];
    expect(claude.hours).toHaveLength(24);
    expect(claude.hours[9]).toBe(2);
    expect(claude.hours.reduce((a, b) => a + b, 0)).toBe(2);
    expect(snapshot.device).toEqual([]);
  });

  it('运行秒数按引擎叠加;同一条会话自己交叠的回合不重复计、也不算并行', () => {
    const snapshot = combineLocalUsage({
      from: '2026-09-23',
      to: '2026-09-23',
      sessions: [],
      intervals: [
        { sessionId: 'a', engine: 'claude', startMs: at(23, 10), endMs: at(23, 11) },
        { sessionId: 'a', engine: 'claude', startMs: at(23, 10, 30), endMs: at(23, 11, 30) },
        { sessionId: 'b', engine: 'codex', startMs: at(23, 11), endMs: at(23, 12) },
      ],
      tokenRows: [],
    });
    expect(snapshot.engines.map((row) => [row.engine, row.runSeconds])).toEqual([
      ['claude', 90 * 60],
      ['codex', 60 * 60],
    ]);
    // a 与 b 在 11:00–11:30 并行;a 自己的两段交叠不算。
    expect(snapshot.device).toEqual([{ day: '2026-09-23', parallelSeconds: 30 * 60, peakConcurrency: 2 }]);
  });

  it('token 全局去重(分叉复制的历史只算一次),按模型分列,四类相加', () => {
    const snapshot = combineLocalUsage({
      from: '2026-09-22',
      to: '2026-09-23',
      sessions: [],
      intervals: [],
      tokenRows: foldTokenEntries([
        token('claude', 'claude:m1:r1', at(23, 10), 'opus', 1),
        token('claude', 'claude:m1:r1', at(23, 10), 'opus', 1), // 分叉文件里的同一条
        token('claude', 'claude:m2:r2', at(23, 11), 'sonnet', 2),
        token('claude', 'claude:m3:r3', at(22, 23, 59), 'opus', 5),
        token('codex', 'claude:m1:r1', at(23, 10), 'gpt', 3), // 键相同但不是同一家:不去重
        token('codex', 'codex:x', at(20, 10), 'gpt', 100), // 范围外
      ]),
    });
    const byKey = Object.fromEntries(snapshot.engines.map((row) => [`${row.day}/${row.engine}`, row]));
    expect(Object.keys(byKey).sort()).toEqual(['2026-09-22/claude', '2026-09-23/claude', '2026-09-23/codex']);
    expect(byKey['2026-09-23/claude']).toMatchObject({
      inputTokens: 3,
      outputTokens: 3,
      cacheReadTokens: 3,
      cacheWriteTokens: 3,
      models: { opus: 4, sonnet: 8 },
      sessions: 0,
    });
    expect(byKey['2026-09-22/claude'].models).toEqual({ opus: 20 });
    expect(byKey['2026-09-23/codex'].inputTokens).toBe(3);
  });

  it('跑不足半秒的区间不出行(秒数四舍五入后为 0)', () => {
    const snapshot = combineLocalUsage({
      from: '2026-09-23',
      to: '2026-09-23',
      sessions: [],
      intervals: [{ sessionId: 'a', engine: 'claude', startMs: at(23, 10), endMs: at(23, 10) + 400 }],
      tokenRows: [],
    });
    expect(snapshot.engines).toEqual([]);
    expect(snapshot.device).toEqual([{ day: '2026-09-23', parallelSeconds: 0, peakConcurrency: 1 }]);
  });
});

describe('foldTokenEntries', () => {
  it('按引擎 × 本地日 × 模型求和;跨午夜的两条落在两天', () => {
    const rows = foldTokenEntries([
      token('claude', 'a', at(22, 23, 59), 'opus', 1),
      token('claude', 'b', at(23, 0, 1), 'opus', 2),
      token('claude', 'c', at(23, 0, 14), 'opus', 3), // 与 b 同一个 15 分钟桶
    ]);
    expect(rows.map((row) => [row.day, row.input]).sort()).toEqual([
      ['2026-09-22', 1],
      ['2026-09-23', 5],
    ]);
  });
});

describe('Token 分来源(咕咕模型 / 自己账号)', () => {
  const tokenIn = (providerSessionId: string, key: string, ts: number, n: number): ProviderTokenEntry => ({
    ...token('claude', key, ts, 'opus', n),
    providerSessionId,
  });

  it('按条目时刻落在哪一段;第一段之前用会话当前选择;都没有的只进总数', () => {
    const snapshot = combineLocalUsage({
      from: '2026-09-23',
      to: '2026-09-23',
      sessions: [],
      intervals: [],
      tokenRows: foldTokenEntries(
        [
          tokenIn('s1', 'a', at(23, 9), 1), // 第一段之前 → fallback byok
          tokenIn('s1', 'b', at(23, 10, 30), 2), // 10:00 起换成咕咕模型
          tokenIn('s1', 'c', at(23, 12, 30), 3), // 12:00 起又换回自己账号
          tokenIn('s2', 'd', at(23, 10), 10), // 没有任何记录 → 说不清
        ],
        { s1: { fallback: 'byok', spans: [[at(23, 10), 'gugu'], [at(23, 12), 'byok']] } }
      ),
    });
    const row = snapshot.engines[0];
    expect(row.models).toEqual({ opus: (1 + 2 + 3 + 10) * 4 });
    expect(row.guguModels).toEqual({ opus: 2 * 4 });
    expect(row.byokModels).toEqual({ opus: (1 + 3) * 4 });
  });
});

describe('sourceAt', () => {
  it('恰好在切换那一刻算新的那段;没有记录也没有当前选择 → null', () => {
    const spans = { fallback: null, spans: [[100, 'gugu']] as Array<[number, 'gugu' | 'byok']> };
    expect(sourceAt(spans, 99)).toBeNull();
    expect(sourceAt(spans, 100)).toBe('gugu');
    expect(sourceAt(undefined, 100)).toBeNull();
  });
});
