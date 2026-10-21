import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  asRecord,
  nonNegativeInt,
  timestampMs,
  type ReaderState,
  type TokenEntry,
  type TokenLogReader,
} from './types';

/**
 * Codex:`<CODEX_HOME>/sessions/<年>/<月>/<日>/rollout-<时间>-<sessionId>.jsonl`(归档的在
 * `<CODEX_HOME>/archived_sessions/` 下,平铺)。
 *
 * 用量在 `{type:'event_msg', payload:{type:'token_count', info:{total_token_usage}}}`,是**本会话累计值** ⇒
 * 一条事件的用量 = 它与上一条累计值之差,归到这条事件的时刻。累计值变小(续接/重置)时这一条按从 0 起算。
 * 模型取此前最近一条 `turn_context.payload.model`。
 *
 * 字段口径(2026-09 本机 rollout 实测:`total_tokens = input_tokens + output_tokens`):
 *   input_tokens **含**缓存命中与缓存写入 ⇒ input = input_tokens − cached_input_tokens − cache_write_input_tokens
 *   cached_input_tokens → cacheRead · cache_write_input_tokens(新版才有,旧版视为 0)→ cacheWrite
 *   output_tokens → output(**已含** reasoning_output_tokens,❌ 再加一遍)
 */

const ROLLOUT_PATTERN =
  /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

type Totals = { input: number; cached: number; cacheWrite: number; output: number; total: number };

type CodexState = { model: string | null; last: Totals | null };

async function listDir(path: string): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw error;
  }
}

async function collectRollouts(
  dir: string,
  depth: number,
  providerSessionIds: ReadonlySet<string>,
  found: Map<string, string[]>
): Promise<void> {
  for (const entry of await listDir(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth > 0) await collectRollouts(path, depth - 1, providerSessionIds, found);
      continue;
    }
    if (!entry.isFile()) continue;
    const match = ROLLOUT_PATTERN.exec(entry.name);
    if (!match) continue;
    const providerSessionId = match[1].toLowerCase();
    if (!providerSessionIds.has(providerSessionId)) continue;
    const list = found.get(providerSessionId);
    if (list) {
      if (!list.includes(path)) list.push(path);
    } else found.set(providerSessionId, [path]);
  }
}

function readTotals(value: unknown): Totals | null {
  const usage = asRecord(value);
  if (!usage) return null;
  const input = nonNegativeInt(usage.input_tokens);
  const output = nonNegativeInt(usage.output_tokens);
  return {
    input,
    cached: nonNegativeInt(usage.cached_input_tokens),
    cacheWrite: nonNegativeInt(usage.cache_write_input_tokens),
    output,
    total: nonNegativeInt(usage.total_tokens) || input + output,
  };
}

function isMonotonic(previous: Totals, current: Totals): boolean {
  return (
    current.input >= previous.input &&
    current.cached >= previous.cached &&
    current.cacheWrite >= previous.cacheWrite &&
    current.output >= previous.output
  );
}

export const codexTokenReader: TokenLogReader = {
  provider: 'codex',

  async locate(configRoots, providerSessionIds) {
    // rollout 文件名里的 id 是小写 uuid;库里的 session_id 按同样口径比。
    const wanted = new Set([...providerSessionIds].map((id) => id.toLowerCase()));
    const byLower = new Map<string, string[]>();
    for (const root of configRoots) {
      await collectRollouts(join(root, 'sessions'), 3, wanted, byLower);
      await collectRollouts(join(root, 'archived_sessions'), 0, wanted, byLower);
    }
    // 还原成调用方给的那个写法。
    const found = new Map<string, string[]>();
    for (const providerSessionId of providerSessionIds) {
      const paths = byLower.get(providerSessionId.toLowerCase());
      if (paths) found.set(providerSessionId, paths);
    }
    return found;
  },

  initialState(): ReaderState {
    const state: CodexState = { model: null, last: null };
    return state;
  },

  mayCarryUsage(line) {
    // 未转义的结构标记(同 claude 那边的理由);codex 写的也是紧凑 JSON。
    return line.includes('"type":"token_count"') || line.includes('"type":"turn_context"');
  },

  readLine(entry, rawState): TokenEntry | null {
    const state = rawState as CodexState;
    const payload = asRecord(entry.payload);
    if (!payload) return null;

    if (entry.type === 'turn_context') {
      if (typeof payload.model === 'string' && payload.model) state.model = payload.model;
      return null;
    }
    if (entry.type !== 'event_msg' || payload.type !== 'token_count') return null;

    const current = readTotals(asRecord(payload.info)?.total_token_usage);
    if (!current) return null;
    const ts = timestampMs(entry.timestamp);
    if (ts === null) return null;

    const previous = state.last;
    const base = previous && isMonotonic(previous, current) ? previous : null;
    state.last = current;

    const dInput = current.input - (base?.input ?? 0);
    const dCached = current.cached - (base?.cached ?? 0);
    const dCacheWrite = current.cacheWrite - (base?.cacheWrite ?? 0);
    const dOutput = current.output - (base?.output ?? 0);
    if (dInput + dOutput === 0) return null;

    return {
      // 同一刻、同一累计值 = 同一条事件(codex 偶尔连写两遍;分叉复制的历史也是这个键)。
      key: `codex:${String(entry.timestamp)}:${current.total}`,
      ts,
      model: state.model ?? 'unknown',
      input: Math.max(0, dInput - dCached - dCacheWrite),
      output: dOutput,
      cacheRead: dCached,
      cacheWrite: dCacheWrite,
    };
  },
};
