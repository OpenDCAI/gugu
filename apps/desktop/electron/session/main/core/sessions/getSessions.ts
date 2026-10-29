import { isNull } from 'drizzle-orm';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { mapSessionRowToSession } from './utils';

/**
 * spec session-graph:**会话的可见性只有一个过滤器** —— `sessions.archived_at`。
 *
 * 唤醒入口也只找未归档会话。身份名录可显式包含归档行,不能借可见列表判死亡或丢失其标题。
 */
export async function getSessions({ includeArchived = false }: { includeArchived?: boolean } = {}) {
  const rows = await db
    .select({ session: sessions })
    .from(sessions)
    .where(includeArchived ? undefined : isNull(sessions.archivedAt));
  return rows.map(({ session }) => mapSessionRowToSession(session, false));
}
