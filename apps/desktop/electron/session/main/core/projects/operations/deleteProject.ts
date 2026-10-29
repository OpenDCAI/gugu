import { eq } from 'drizzle-orm';
import { projectEvents } from '@main/core/projects/project-events';
import { projectManager } from '@main/core/projects/project-manager';
import { projectGroupHost } from '@main/core/projects/project-group-host';
import { prSyncEngine } from '@main/core/pull-requests/pr-sync-engine';
import { countSessionAgents } from '@main/core/sessionpage/sessionpage-session-agent';
import { viewStateService } from '@main/core/view-state/view-state-service';
import { db } from '@main/db/client';
import { automations, sessions, projects } from '@main/db/schema';
import type { ProjectDeletionImpact } from '@shared/projects';
import { detachProjectFolder, listProjectFolderRefs } from './project-folders';
import { getProjectById } from './getProjects';

/** Read the owning host's facts; a failed lookup must not become a zero count. */
export async function getProjectDeletionImpact(id: string): Promise<ProjectDeletionImpact> {
  if (!(await getProjectById(id))) throw new Error(`Project not found: ${id}`);
  const rows = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.projectId, id));
  const bindings = await projectGroupHost().listBindings([id]);
  if (!bindings.success) throw new Error(bindings.error.message);
  return {
    tasks: rows.length,
    agents: await countSessionAgents(rows.map((row) => row.id), process.env),
    groups: new Set(bindings.data.map((binding) => binding.chatId)).size,
  };
}

export async function deleteProject(id: string): Promise<void> {
  const provider = projectManager.getProject(id);
  const sessionRows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.projectId, id));
  // Project removal is recoverable task archival, never orphan identity cleanup.
  // Keep the original project/session/workspace keys so Task history's existing
  // Restore path can reopen the same identity and memberships, including offline.
  if (sessionRows.length > 0) {
    const { archiveSession } = await import('@main/core/sessions/archiveSession');
    for (const row of sessionRows) await archiveSession(id, row.id);
  }
  if (provider) await projectManager.closeProject(id);

  await prSyncEngine.deleteProjectData(id);
  if (sessionRows.length > 0) {
    const folders = await listProjectFolderRefs(id);
    if (!folders) throw new Error(`Project not found: ${id}`);
    for (const folder of folders) {
      const detached = await detachProjectFolder(id, folder.workspaceId);
      if (!detached.success) throw new Error(detached.error.message);
    }
    // A task may have finished creation while the initial tasks were being
    // archived. Re-read after detaching folders instead of leaving it active.
    const initialIds = new Set(sessionRows.map((row) => row.id));
    const remaining = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.projectId, id));
    const { archiveSession } = await import('@main/core/sessions/archiveSession');
    for (const row of remaining) {
      if (!initialIds.has(row.id)) await archiveSession(id, row.id);
    }
    // The project row survives for Restore, so reproduce its old ON DELETE SET
    // NULL effect for automations explicitly. No task outputs/history are erased.
    await db.update(automations).set({ projectId: null }).where(eq(automations.projectId, id));
    void viewStateService.del(`project:${id}`);
    // detachProjectFolder already published the existing visibility change.
    // The retained project is not a deleted row, so do not signal orphan cleanup.
    return;
  }
  // An empty project has no restorable bindings and keeps the existing removal.
  const deleted = await db.delete(projects).where(eq(projects.id, id)).returning({ id: projects.id });
  void viewStateService.del(`project:${id}`);
  if (deleted.length > 0) projectEvents._emit('project:deleted', id);
}
