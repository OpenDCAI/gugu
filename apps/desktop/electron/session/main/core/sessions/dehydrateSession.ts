import { and, eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { resolveSession } from '../projects/utils';

export async function dehydrateSession(
  projectId: string,
  sessionId: string
): Promise<void> {
  const [row] = await db
    .select({ type: sessions.runtime })
    .from(sessions)
    .where(
      and(
        eq(sessions.id, sessionId),
        eq(sessions.projectId, projectId),
      )
    )
    .limit(1);

  if (row?.type === 'acp') {
    return;
  }

  const session = resolveSession(projectId, sessionId);
  await session?.sessions.detachSession(sessionId);
}
