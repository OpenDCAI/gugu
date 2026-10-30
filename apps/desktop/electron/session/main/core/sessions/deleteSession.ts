import { getAcpRuntimeClient } from '@main/core/acp/controller';
import { projectManager } from '@main/core/projects/project-manager';
import { cleanupDetachedSessions, sessionWorkspaceManager } from './session-workspace-manager';
import { log } from '@main/lib/logger';

/**
 * 停掉一条会话的运行时,删除与归档同一个配方:挂着就拆它的挂载(会话进程、它的终端、ACP 那条腿,工作区
 * 按引用计数放掉);没挂载就直接收 ACP 会话 / tmux 会话。
 *
 * 拆挂载失败只记一笔:那条路失败时自己已经把这条会话的 tmux 会话收掉了(session-workspace-manager 的兜底)。
 * 没挂载的 ACP 会话停不下来就抛 —— 一条还在跑的会话被从列表里收起,人再也点不到它,却仍在花钱。
 *
 * `skipTransportStop`:provider 从没启动过(spawn 的补偿路径),只拆挂载,不去停一个不存在的进程。
 */
export async function stopSessionRuntime(
  projectId: string,
  sessionId: string,
  runtime: string | null,
  mode: 'terminate' | 'archive',
  skipTransportStop = false
): Promise<void> {
  if (sessionWorkspaceManager.getSession(sessionId)) {
    const result = await sessionWorkspaceManager.teardownSession(sessionId, mode);
    if (!result.success) {
      log.warn('stopSessionRuntime: teardown failed', { sessionId, mode, error: result.error.message });
    }
    return;
  }
  if (skipTransportStop) return;
  if (runtime === 'acp') {
    const result = await (await getAcpRuntimeClient()).stopSession({ sessionId });
    if (!result.success) throw new Error('failed to stop ACP session');
    return;
  }
  const project = projectManager.getProject(projectId);
  if (project) await cleanupDetachedSessions(projectId, sessionId, project.ctx);
}
