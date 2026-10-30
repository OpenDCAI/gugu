import { eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { events } from '@main/lib/events';
import { sessionChangedChannel } from '@shared/core/sessions/sessionEvents';
import { archiveSession } from './archiveSession';
import { publishProjectVisibility } from '../projects/operations/project-visibility';

/** Only confirmed identity deletion removes task history. Automatic cleanup still archives. */
export async function permanentlyDeleteAgentSession(sessionId: string): Promise<void> {
  const row = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
  if (!row) return;
  // Reuse archival for runtime teardown and removal from every open task list.
  try {
    await archiveSession(row.projectId, sessionId);
  } finally {
    // A failed stop cannot leave a restorable task for an identity that no longer exists.
    // Session-owned messages, turns and attachment rows follow the existing SQLite cascade.
    db.delete(sessions).where(eq(sessions.id, sessionId)).run();
    events.emit(sessionChangedChannel, {
      projectId: row.projectId,
      sessionId,
      changes: { archivedAt: row.archivedAt ?? new Date().toISOString() },
    });
    await publishProjectVisibility(row.projectId);
  }
}
