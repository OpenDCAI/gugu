import { eq } from 'drizzle-orm';
import { projectEvents } from '@main/core/projects/project-events';
import { projectManager } from '@main/core/projects/project-manager';
import { prSyncEngine } from '@main/core/pull-requests/pr-sync-engine';
import { forgetSessionOutputs } from '@main/core/sessions/session-outputs';
import { sessionWorkspaceManager } from '@main/core/sessions/session-workspace-manager';
import { viewStateService } from '@main/core/view-state/view-state-service';
import { db } from '@main/db/client';
import { sessions, projects } from '@main/db/schema';

export async function deleteProject(id: string): Promise<void> {
  const provider = projectManager.getProject(id);
  const sessionRows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.projectId, id));
  // 会话随项目一起删(外键级联),它们的视图状态与「输出」就在这里一起收:启动时 ❌ 再按「不在本机表里」猜孤儿去删。
  await Promise.allSettled([
    ...(provider ? sessionRows.map((c) => sessionWorkspaceManager.teardownSession(c.id)) : []),
    ...sessionRows.map((c) => viewStateService.del(`session:${c.id}`)),
    ...sessionRows.map((c) => viewStateService.del(`session:${c.id}:tabs`)),
    ...sessionRows.map((c) => forgetSessionOutputs(c.id)),
  ]);
  if (provider) await projectManager.closeProject(id);

  await prSyncEngine.deleteProjectData(id);
  const deleted = await db.delete(projects).where(eq(projects.id, id)).returning({ id: projects.id });
  void viewStateService.del(`project:${id}`);
  if (deleted.length > 0) projectEvents._emit('project:deleted', id);
}
