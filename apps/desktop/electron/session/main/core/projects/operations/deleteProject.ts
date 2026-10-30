import { eq } from 'drizzle-orm';
import { projectEvents } from '@main/core/projects/project-events';
import { projectManager } from '@main/core/projects/project-manager';
import { prSyncEngine } from '@main/core/pull-requests/pr-sync-engine';
import { archiveSession } from '@main/core/sessions/archiveSession';
import { viewStateService } from '@main/core/view-state/view-state-service';
import { db } from '@main/db/client';
import { automations, sessions, projects } from '@main/db/schema';

import { detachProjectFolder, listProjectFolderRefs } from './project-folders';

export async function deleteProject(id: string): Promise<void> {
  const provider = projectManager.getProject(id);
  const sessionRows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.projectId, id));
  for (const row of sessionRows) await archiveSession(id, row.id);
  if (provider) await projectManager.closeProject(id);

  await prSyncEngine.deleteProjectData(id);
  if (sessionRows.length) {
    const folders = await listProjectFolderRefs(id);
    if (!folders) throw new Error(`Project not found: ${id}`);
    for (const folder of folders) {
      const result = await detachProjectFolder(id, folder.workspaceId);
      if (!result.success) throw new Error(result.error.message);
    }
    await db.update(automations).set({ projectId: null }).where(eq(automations.projectId, id));
    void viewStateService.del(`project:${id}`);
    return;
  }
  const deleted = await db.delete(projects).where(eq(projects.id, id)).returning({ id: projects.id });
  void viewStateService.del(`project:${id}`);
  if (deleted.length > 0) projectEvents._emit('project:deleted', id);
}
