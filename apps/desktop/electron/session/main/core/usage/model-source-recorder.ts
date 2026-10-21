import { asc, desc, eq, like } from 'drizzle-orm';
import { db } from '@main/db/client';
import { sessionModelSources, sessions, kv } from '@main/db/schema';
import { log } from '@main/lib/logger';
import type { ModelSource, SourceSpans } from './model-source';

/**
 * 用量页把 Token 分成「咕咕模型」与「自己账号」两份的底账。
 *
 * 写:会话每次启动、计费路定下来的那一刻(sessionpage-platform-model 的 platformModelForSession)
 * 记一笔;与这条会话的上一笔相同就不记 —— 同一来源的反复重启不产生新行。
 * 读:给 token 扫描一张「会话 → 时间段 → 来源」的表(见 model-source.ts 的归属规则)。
 *
 * 任何失败只记日志,❌ 不抛:这是统计,不能让会话因此起不来。
 */
export function recordModelSource(sessionId: string, source: ModelSource, at: number = Date.now()): void {
  try {
    const last = db
      .select({ source: sessionModelSources.source })
      .from(sessionModelSources)
      .where(eq(sessionModelSources.sessionId, sessionId))
      .orderBy(desc(sessionModelSources.startedAt))
      .limit(1)
      .get();
    if (last?.source === source) return;
    db.insert(sessionModelSources).values({ sessionId, source, startedAt: at }).run();
  } catch (error) {
    log.warn('usage: failed to record a session model source', { sessionId, source, error: String(error) });
  }
}

const PLATFORM_MODEL_KEY_PREFIX = 'sessionpage-platform-model:';

/**
 * sessionId → 这条会话的来源时间段。
 *
 * 有启动记录的按记录;第一笔记录之前(这张表出现之前的历史)退回会话级的当前选择
 * (kv `sessionpage-platform-model:<id>`:选了咕咕模型 / 选了自家模型)。两样都没有 = 说不清,
 * 那部分 Token 不归到任何一边,用量页如实显示为「未区分」,❌ 不猜。
 */
export function readSourceSpansByProviderSession(): Map<string, SourceSpans> {
  const providerSessionBySession = new Map<string, string>();
  for (const row of db.select({ id: sessions.id, providerSessionId: sessions.providerSessionId }).from(sessions).all()) {
    const providerSessionId = row.providerSessionId?.trim();
    if (providerSessionId) providerSessionBySession.set(row.id, providerSessionId);
  }
  const out = new Map<string, SourceSpans>();
  const spansFor = (sessionId: string): SourceSpans | null => {
    const providerSessionId = providerSessionBySession.get(sessionId);
    if (!providerSessionId) return null;
    let spans = out.get(providerSessionId);
    if (!spans) {
      spans = { fallback: null, spans: [] };
      out.set(providerSessionId, spans);
    }
    return spans;
  };
  for (const row of db
    .select({ key: kv.key, value: kv.value })
    .from(kv)
    .where(like(kv.key, `${PLATFORM_MODEL_KEY_PREFIX}%`))
    .all()) {
    const spans = spansFor(row.key.slice(PLATFORM_MODEL_KEY_PREFIX.length));
    if (!spans) continue;
    spans.fallback = currentSourceFromKv(row.value);
  }
  for (const row of db
    .select({
      sessionId: sessionModelSources.sessionId,
      source: sessionModelSources.source,
      startedAt: sessionModelSources.startedAt,
    })
    .from(sessionModelSources)
    .orderBy(asc(sessionModelSources.startedAt))
    .all()) {
    if (row.source !== 'gugu' && row.source !== 'byok') continue;
    spansFor(row.sessionId)?.spans.push([row.startedAt, row.source]);
  }
  return out;
}

/** kv 里那条会话级选择 → 来源。`{platformModel:{…}}` 咕咕模型;`{platformModel:null}` 自家模型;其余说不清。 */
export function currentSourceFromKv(value: string | null): ModelSource | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { platformModel?: unknown };
    if (!('platformModel' in parsed)) return null;
    if (parsed.platformModel === null) return 'byok';
    return typeof parsed.platformModel === 'object' ? 'gugu' : null;
  } catch {
    return null;
  }
}
