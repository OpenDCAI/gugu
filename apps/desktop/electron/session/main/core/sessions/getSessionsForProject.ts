import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { mapSessionRowToSession } from './utils';

/**
 * spec session-graph:会话的可见性只有一个过滤器 —— `sessions.archived_at`。项目页与侧栏的会话列表都从这里读。
 */
export async function getSessionsForProject(projectId: string) {
  const rows = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.projectId, projectId), isNull(sessions.archivedAt)));
  return rows.map((r) => mapSessionRowToSession(r, false));
}
