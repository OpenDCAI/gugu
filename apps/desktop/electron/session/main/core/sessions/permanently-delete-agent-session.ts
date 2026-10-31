import { eq, or, sql } from 'drizzle-orm';
import { db } from '@main/db/client';
import { activityEvents, activitySessionProjects, kv, sessionModelSources, sessionRunIntervals, sessions } from '@main/db/schema';
import { events } from '@main/lib/events';
import { sessionChangedChannel } from '@shared/core/sessions/sessionEvents';
import { viewStateService } from '../view-state/view-state-service';
import { archiveOneLocked } from './archiveSession';
import { sessionLife } from './session-life';
import { sessionWorkspaceManager } from './session-workspace-manager';
import { serializeSessionArchival } from './session-archival';
import { deleteSessionAttachmentFiles } from './attachments/session-attachment-store';
import { tombstoneDeletedSession } from './fork-capture';
import { forgetSessionPlatformModel } from './platform-model-selection';
import { forgetSessionOutputs } from './session-outputs';
import { deleteWorkspaceIfUnused } from './operations/session-lifecycle-utils';
import { publishProjectVisibility } from '../projects/operations/project-visibility';
import { sessionEvents } from './session-events';

/** Only confirmed identity deletion removes task history. Automatic cleanup still archives. */
export async function permanentlyDeleteAgentSession(sessionId: string): Promise<void> {
  return serializeSessionArchival(sessionId, async () => {
    const row = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    if (!row) return;
    tombstoneDeletedSession([sessionId, row.providerSessionId]);
    // Hold the same lock through stop, file cleanup and deletion; Restore cannot interleave.
    try {
      // ACP: session-life's delete stops the run, ends its dependents and removes the row; nothing is left to
      // archive. Other runtimes archive first as before.
      if (row.runtime === 'acp') {
        // The workspace mount is not a session-life lease (ACP stops never unmount): release it here, then delete.
        if (sessionWorkspaceManager.getSession(sessionId)) {
          const released = await sessionWorkspaceManager.teardownSession(sessionId, 'archive');
          if (!released.success) throw new Error(`session ${sessionId} workspace could not be released: ${released.error.message}`);
        }
        await sessionLife().interrupt(sessionId, { k: 'interrupt', reason: 'delete' });
      }
      else await archiveOneLocked(row.projectId, sessionId, false);
    } finally {
      try {
        // Read owned file paths before their rows cascade away. User references stay untouched.
        await deleteSessionAttachmentFiles(sessionId);
      } finally {
        // Even a failed stop/file removal cannot leave a restorable task for a deleted identity.
        const refusalPrefix = `session-archival-refusal:${sessionId}:`;
        db.transaction((tx) => {
          tx.delete(activityEvents).where(eq(activityEvents.sessionId, sessionId)).run();
          tx.delete(sessionRunIntervals).where(eq(sessionRunIntervals.sessionId, sessionId)).run();
          tx.delete(sessionModelSources).where(eq(sessionModelSources.sessionId, sessionId)).run();
          tx.delete(activitySessionProjects).where(eq(activitySessionProjects.sessionId, sessionId)).run();
          tx.delete(kv).where(or(eq(kv.key, `session-archival:${sessionId}`), sql`substr(${kv.key}, 1, ${refusalPrefix.length}) = ${refusalPrefix}`)).run();
          tx.delete(sessions).where(eq(sessions.id, sessionId)).run();
        });
        sessionEvents._emit('session:deleted', sessionId);
        await Promise.all([
          forgetSessionPlatformModel(sessionId), forgetSessionOutputs(sessionId),
          viewStateService.del(`session:${sessionId}`), viewStateService.del(`session:${sessionId}:tabs`),
        ]);
        if (row.workspaceId) await deleteWorkspaceIfUnused(row.workspaceId, sessionId);
        events.emit(sessionChangedChannel, {
          projectId: row.projectId, sessionId,
          changes: { archivedAt: row.archivedAt ?? new Date().toISOString() },
        });
        await publishProjectVisibility(row.projectId);
      }
    }
  });
}
