import { inArray } from 'drizzle-orm';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import type { SessionProjectLocation } from '@shared/core/projects/session-project-references';

/** Primary-key lookups only: restoring a few panes must not scan the account's session directory. */
export function sessionProjectLocations(sessionIds: string[]): SessionProjectLocation[] {
  const ids = [...new Set(sessionIds)];
  if (!ids.length) return [];
  return db.select({ conversationId: sessions.id, projectId: sessions.projectId })
    .from(sessions).where(inArray(sessions.id, ids)).all();
}
