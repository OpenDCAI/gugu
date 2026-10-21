import { eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { kv } from '@main/db/schema';

/**
 * #6264 一条会话**没开起来**的原因码,记在这台机器上。
 *
 * 为什么要记:建会话时会话行已经写下、agent 却没起来(模型服务连不上、引擎起不来)。这条会话必须照样
 * 打得开(spec session-always-openable),而打开它的可能是另一台桌面、另一天 —— 那时手里只剩这台机器。
 * 所以原因码跟着会话记在这里,会话列表与转录里那一行都从这儿读;**原文不记**(原文进日志)。
 *
 * 同步读写:会话列表(`listSessionStates`)是同步拼的。键按会话 id,会话起来了就清掉。
 */
const PREFIX = 'session-start-failure:';

function key(sessionId: string): string {
  return `${PREFIX}${sessionId}`;
}

export function recordStartFailure(sessionId: string, code: string): void {
  const value = JSON.stringify({ code, at: Date.now() });
  db.insert(kv)
    .values({ key: key(sessionId), value, updatedAt: Date.now() })
    .onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: Date.now() } })
    .run();
}

export function readStartFailure(sessionId: string): string | null {
  const row = db.select({ value: kv.value }).from(kv).where(eq(kv.key, key(sessionId))).get();
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as { code?: unknown };
    return typeof parsed.code === 'string' ? parsed.code : null;
  } catch {
    return null;
  }
}

export function clearStartFailure(sessionId: string): void {
  db.delete(kv).where(eq(kv.key, key(sessionId))).run();
}
