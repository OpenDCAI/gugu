import { eq } from 'drizzle-orm';
import { projectEvents } from '@main/core/projects/project-events';
import { projectManager } from '@main/core/projects/project-manager';
import { prSyncEngine } from '@main/core/pull-requests/pr-sync-engine';
import { sessionWorkspaceManager } from '@main/core/sessions/session-workspace-manager';
import { viewStateService } from '@main/core/view-state/view-state-service';
import { db } from '@main/db/client';
import { sessions, projects } from '@main/db/schema';

export async function deleteProject(id: string): Promise<void> {
  const provider = projectManager.getProject(id);
  if (provider) {
    const sessionRows = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.projectId, id));
    await Promise.allSettled([
      ...sessionRows.map((c) => sessionWorkspaceManager.teardownSession(c.id)),
      ...sessionRows.map((c) => viewStateService.del(`session:${c.id}`)),
      ...sessionRows.map((c) => viewStateService.del(`session:${c.id}:tabs`)),
    ]);
    await projectManager.closeProject(id);
  }

  await prSyncEngine.deleteProjectData(id);
  await db.delete(projects).where(eq(projects.id, id));
  void viewStateService.del(`project:${id}`);
  projectEvents._emit('project:deleted', id);
}
