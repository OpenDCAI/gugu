import { eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';

/** A late program callback cannot open a new resource for an already-ended task. */
export async function projectionTaskProject(sessionId: string): Promise<string> {
  const [task] = await db.select({ projectId: sessions.projectId, archivedAt: sessions.archivedAt })
    .from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  if (!task || task.archivedAt !== null) throw new Error('Projection task has ended');
  return task.projectId;
}
