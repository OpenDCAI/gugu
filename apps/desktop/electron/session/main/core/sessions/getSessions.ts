import { isNull } from 'drizzle-orm';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { mapSessionRowToSession } from './utils';

/**
 * spec session-graph:**会话的可见性只有一个过滤器** —— `sessions.archived_at`。
 *
 * 唤醒入口也只找未归档会话。身份回收使用独立的存在性清单,不能借可见列表判死亡。
 */
export async function getSessions() {
  const rows = await db
    .select({ session: sessions })
    .from(sessions)
    .where(isNull(sessions.archivedAt));
  return rows.map(({ session }) => mapSessionRowToSession(session, false));
}
