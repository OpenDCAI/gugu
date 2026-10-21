import { getProjectManagerStore } from '@renderer/features/projects/stores/project-selectors';
import { getSessionManagerStore } from '@renderer/features/sessions/stores/session-selectors';
import { rpc } from '@renderer/lib/ipc';
import type { Session } from '@shared/core/sessions/sessions';

/**
 * spec session-graph / session-page「会话历史」(#6083):把一条已归档的会话恢复回列表 —— 唯一路径。
 *
 * 恢复不只是库里抹掉 `archived_at`(`restoreSession` 那半):渲染侧归档时已经把这条会话的那一份收掉了,
 * 所以这里把主进程返回的那一行**放回来**(主进程同时发 session:created,先到的那一次生效)。范围只有点名的
 * 这一条:它 spawn 出的子会话各自是一行,各自恢复。
 */
export async function restoreArchivedSession(ref: {
  projectId: string;
  sessionId: string;
}): Promise<Session> {
  const restored = await rpc.sessions.restoreSession(ref.projectId, ref.sessionId);
  // 项目可能还没挂(从没在这个 app 生命周期里打开过):挂上之后它的表从库里读,读到的已经是恢复后的行。
  await getProjectManagerStore().ensureProjectLoaded(ref.projectId);
  getSessionManagerStore(ref.projectId)?.acceptCreatedSession(restored);
  return restored;
}
