import { eq, sql } from 'drizzle-orm';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { events } from '@main/lib/events';
import { sessionChangedChannel } from '@shared/core/sessions/sessionEvents';

/**
 * 把一条自动化运行建出来的会话收成普通会话:它从此出现在会话列表里,不再只挂在那次运行下面。
 * 自动化的标记只有 `automation_run_id` 这一格,收成普通会话就是清掉它。
 */
export async function convertAutomationSession(sessionId: string): Promise<void> {
  const [row] = await db
    .update(sessions)
    .set({ automationRunId: null, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(eq(sessions.id, sessionId))
    .returning({ projectId: sessions.projectId });
  if (!row) throw new Error(`Session not found: ${sessionId}`);
  events.emit(sessionChangedChannel, {
    sessionId,
    projectId: row.projectId,
    changes: { automationRunId: null },
  });
}
