import { eq } from 'drizzle-orm';
import { projectEvents } from '@main/core/projects/project-events';
import { projectManager } from '@main/core/projects/project-manager';
import { prSyncEngine } from '@main/core/pull-requests/pr-sync-engine';
import { viewStateService } from '@main/core/view-state/view-state-service';
import { db } from '@main/db/client';
import { automations, sessions, projects } from '@main/db/schema';

export async function deleteProject(id: string): Promise<void> {
  const archive = async (sessionId: string) =>
    (await import('@main/core/sessions/archiveSession')).archiveSession(id, sessionId);
  const provider = projectManager.getProject(id);
  const sessionRows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.projectId, id));
  for (const row of sessionRows) await archive(row.id);
  if (provider) await projectManager.closeProject(id);

  await prSyncEngine.deleteProjectData(id);
  // Cleanup awaits can admit another task. Read the durable inventory at the delete
  // write point; the empty check and project deletion must share one transaction.
  const current = db.transaction(tx => {
    const rows = tx.select({ id: sessions.id }).from(sessions).where(eq(sessions.projectId, id)).all();
    const deleted = rows.length ? [] : tx.delete(projects).where(eq(projects.id, id)).returning({ id: projects.id }).all();
    return { rows, deleted };
  });
  if (current.rows.length) {
    for (const row of current.rows) await archive(row.id);
    // Keep the original root and every attached folder, including folders with no
    // tasks. Restore must expose those same memberships rather than reconstructing them.
    await db.update(projects).set({ archivedAt: new Date().toISOString() }).where(eq(projects.id, id));
    await db.update(automations).set({ projectId: null }).where(eq(automations.projectId, id));
    void viewStateService.del(`project:${id}`);
    projectEvents._emit('project:deleted', id);
    return;
  }
  void viewStateService.del(`project:${id}`);
  if (current.deleted.length > 0) projectEvents._emit('project:deleted', id);
}
