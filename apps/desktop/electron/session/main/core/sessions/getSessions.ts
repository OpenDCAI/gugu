import { isNull } from 'drizzle-orm';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { mapSessionRowToSession } from './utils';

/**
 * spec session-graph:**会话的可见性只有一个过滤器** —— `sessions.archived_at`。
 *
 * 这一处同时是会话页投影给社交侧的 roster diff 的源(embedded-boot 的对账),所以归档对 agent 身份
 * 与删除同效(product spec ⑨「归档与删除对 agent 身份同效,都是硬移除」)就落在这一个改动上。
 */
export async function getSessions() {
  const rows = await db
    .select({ session: sessions })
    .from(sessions)
    .where(isNull(sessions.archivedAt));
  return rows.map(({ session }) => mapSessionRowToSession(session, false));
}
