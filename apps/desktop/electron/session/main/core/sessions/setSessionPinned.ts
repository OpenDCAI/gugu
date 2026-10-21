import { eq, sql } from 'drizzle-orm';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { events } from '@main/lib/events';
import { sessionChangedChannel } from '@shared/core/sessions/sessionEvents';

export async function setSessionPinned(sessionId: string, isPinned: boolean): Promise<void> {
  const [row] = await db
    .select({ projectId: sessions.projectId })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (!row) throw new Error(`Session not found: ${sessionId}`);

  await db
    .update(sessions)
    .set({
      isPinned: isPinned ? 1 : 0,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(sessions.id, sessionId));

  // 桌面侧栏与手机置顶都经这一个写入口:渲染层据此当场挪行,手机的列表订阅也旁听这一条。
  events.emit(sessionChangedChannel, {
    sessionId,
    projectId: row.projectId,
    changes: { isPinned },
  });
}
