import { and, asc, gt, isNotNull, isNull, lt, or } from 'drizzle-orm';
import type { LocalUsageRequest, LocalUsageSnapshot } from '@gugu/core/shared/usage/dailyUsage';
import { resolveAgentHomeEnv, resolveAgentHomeRoot } from '@main/core/agents/agent-home';
import { db } from '@main/db/client';
import { sessionRunIntervals, sessions, usageTokenFileCache } from '@main/db/schema';
import { log } from '@main/lib/logger';
import { UNKNOWN_ENGINE, combineLocalUsage } from './combine-local-usage';
import { sqliteTextToMs } from './local-day';
import { rangeBoundsMs, type RunInterval } from './run-interval-math';
import { readSourceSpansByProviderSession } from './model-source-recorder';
import { runIntervalRecorder } from './run-interval-recorder';
import { createTokenScanClient, type TokenCachePager, type TokenScanResult } from './token-scan-client';
import { spawnTokenScanWorker } from './token-scan-worker/spawn';
import { TOKEN_LOG_READERS } from './token-readers/registry';
import { configRootsFor } from './token-scan';
import { requireNativeHome } from '@gugu/session-plugins/agents';

/** `usage_token_file_cache` 的库实现(分页读,逐行写)。 */
export const dbTokenCachePager: TokenCachePager = {
  loadPage(afterPath, limit) {
    return db
      .select({
        path: usageTokenFileCache.path,
        size: usageTokenFileCache.size,
        mtimeMs: usageTokenFileCache.mtimeMs,
        data: usageTokenFileCache.data,
      })
      .from(usageTokenFileCache)
      .where(gt(usageTokenFileCache.path, afterPath))
      .orderBy(asc(usageTokenFileCache.path))
      .limit(limit)
      .all();
  },
  save(row) {
    db.insert(usageTokenFileCache)
      .values(row)
      .onConflictDoUpdate({
        target: usageTokenFileCache.path,
        set: {
          size: row.size,
          mtimeMs: row.mtimeMs,
          provider: row.provider,
          providerSessionId: row.providerSessionId,
          data: row.data,
        },
      })
      .run();
  },
};

let tokenScanClient: ReturnType<typeof createTokenScanClient> | null = null;

function getTokenScanClient(): ReturnType<typeof createTokenScanClient> {
  tokenScanClient ??= createTokenScanClient({
    spawn: spawnTokenScanWorker,
    cache: dbTokenCachePager,
    onFileError: (path, error) => log.warn('usage: failed to read a token log file', { path, error }),
    onSaveError: (path, error) =>
      log.warn('usage: failed to persist a token log cache row', { path, error: String(error) }),
  });
  return tokenScanClient;
}

/**
 * 扫一轮咕咕会话的 token 日志(在 worker 线程里,见 token-scan-worker/protocol.ts),交回已去重、
 * 已按「引擎 × 本地日 × 模型」求和的行。只读咕咕会话的日志:按 sessions.provider_session_id 找文件,
 * 本机其他 CLI 会话一律不碰。
 */
export async function scanGuguTokens(): Promise<TokenScanResult> {
  const providers = TOKEN_LOG_READERS.map((reader) => reader.provider);
  const providerSessions = db
    .select({ provider: sessions.provider, providerSessionId: sessions.providerSessionId })
    .from(sessions)
    .where(isNotNull(sessions.providerSessionId))
    .all()
    .filter((row): row is { provider: string; providerSessionId: string } =>
      row.provider !== null && row.providerSessionId !== null && providers.includes(row.provider)
    )
    .map((row) => ({ provider: row.provider, providerSessionId: row.providerSessionId.trim() }))
    .filter((row) => row.providerSessionId.length > 0);
  const rootsByProvider: Record<string, string[]> = {};
  for (const reader of TOKEN_LOG_READERS) {
    const [root, env] = await Promise.all([
      resolveAgentHomeRoot(reader.provider),
      resolveAgentHomeEnv(reader.provider),
    ]);
    rootsByProvider[reader.provider] = configRootsFor(requireNativeHome(reader.provider), { root, env });
  }
  const startedAt = Date.now();
  const sourcesByProviderSession = Object.fromEntries(readSourceSpansByProviderSession());
  const result = await getTokenScanClient().scan({ providerSessions, rootsByProvider, sourcesByProviderSession });
  log.info('usage: token log scan finished', { ...result.stats, ms: Date.now() - startedAt });
  return result;
}

/** 与这个日期范围相交的运行区间;还开着的按 now 收。 */
function readIntervals(startMs: number, endMs: number, now: number): RunInterval[] {
  const rows = db
    .select({
      sessionId: sessionRunIntervals.sessionId,
      provider: sessionRunIntervals.provider,
      startedAt: sessionRunIntervals.startedAt,
      endedAt: sessionRunIntervals.endedAt,
    })
    .from(sessionRunIntervals)
    .where(
      and(
        lt(sessionRunIntervals.startedAt, endMs),
        or(isNull(sessionRunIntervals.endedAt), gt(sessionRunIntervals.endedAt, startMs))
      )
    )
    .all();
  return rows.map((row) => ({
    sessionId: row.sessionId,
    engine: row.provider ?? UNKNOWN_ENGINE,
    startMs: row.startedAt,
    endMs: row.endedAt ?? Math.max(row.startedAt, now),
  }));
}

/**
 * `usage.localDaily` 的实现:本机 from..to(含)每天 × 每家引擎的量。
 * 会话数按 sessions.created_at(含已归档;删掉的行已不在库里,不计)。
 */
export async function buildLocalUsageSnapshot(
  request: LocalUsageRequest,
  now: number = Date.now()
): Promise<LocalUsageSnapshot> {
  // 先对一次账:让「此刻在跑」的那几条的区间是新的,而不是停在上一次心跳。
  // 与下面读区间用同一个 now:对账与取数对「此刻」只能有一个说法。
  runIntervalRecorder.reconcile(now);

  const { startMs, endMs } = rangeBoundsMs(request.from, request.to);
  const sessionRows = db
    .select({ provider: sessions.provider, createdAt: sessions.createdAt })
    .from(sessions)
    .all()
    .flatMap((row) => {
      const createdAtMs = sqliteTextToMs(row.createdAt);
      return createdAtMs === null ? [] : [{ engine: row.provider ?? UNKNOWN_ENGINE, createdAtMs }];
    });
  const intervals = readIntervals(startMs, endMs, now);
  const { rows: tokenRows } = await scanGuguTokens();

  return combineLocalUsage({
    from: request.from,
    to: request.to,
    sessions: sessionRows,
    intervals,
    tokenRows,
  });
}
