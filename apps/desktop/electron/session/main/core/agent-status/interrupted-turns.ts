import { eq, like } from 'drizzle-orm';
import type { InterruptedBy } from '@shared/core/sessions/sessions';
import { db } from '@main/db/client';
import { kv } from '@main/db/schema';

/**
 * 开机收残收下的那几条会话:那一轮是被什么打断的(宿主更新 / 重启 / 上一次没正常退出)。
 * 会话行上记 `error`(要人处理),这里记原因;会话页在它还是 `error` 时在末尾说一句,下一轮开工就清掉。
 * ❌ 往历史里补一轮:那一轮从没落库,库里一空就回退去读引擎重放 —— 补一条反倒把整段对话藏掉。
 * 同步读:行 → 会话的映射器(`mapSessionRowToSession`)是同步的。
 */
const PREFIX = 'session-interrupted:';

export function recordInterruptedTurns(sessionIds: readonly string[], by: InterruptedBy, now = Date.now()): void {
  const value = JSON.stringify({ by, at: now });
  for (const sessionId of sessionIds) {
    db.insert(kv)
      .values({ key: `${PREFIX}${sessionId}`, value, updatedAt: now })
      .onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: now } })
      .run();
  }
}

export function readInterruptedTurn(sessionId: string): InterruptedBy | null {
  const row = db.select({ value: kv.value }).from(kv).where(eq(kv.key, `${PREFIX}${sessionId}`)).get();
  if (!row) return null;
  try {
    const by = (JSON.parse(row.value) as { by?: unknown }).by;
    return by === 'update' || by === 'restart' || by === 'unclean' ? by : null;
  } catch {
    return null;
  }
}

export function clearInterruptedTurn(sessionId: string): void {
  db.delete(kv).where(eq(kv.key, `${PREFIX}${sessionId}`)).run();
}

/** 有没有记着的(测试用)。 */
export function interruptedTurnKeys(): string[] {
  return db.select({ key: kv.key }).from(kv).where(like(kv.key, `${PREFIX}%`)).all().map((row) => row.key);
}
