import { and, eq, or } from 'drizzle-orm';
import { getAcpRuntimeClient } from '@main/core/acp/controller';
import { projectManager } from '@main/core/projects/project-manager';
import { deleteSessionAttachmentFiles } from '@main/core/sessions/attachments/session-attachment-store';
import { deleteWorkspaceIfUnused } from '@main/core/sessions/operations/session-lifecycle-utils';
import { cleanupDetachedSessions, sessionWorkspaceManager } from '@main/core/sessions/session-workspace-manager';
import { viewStateService } from '@main/core/view-state/view-state-service';
import { forgetSessionOutputs } from './session-outputs';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import {
  sessionChangedChannel,
  sessionDeletedChannel,
} from '@shared/core/sessions/sessionEvents';
import { sessionEvents } from './session-events';
import { tombstoneDeletedSession } from './fork-capture';
import { forgetSessionPlatformModel } from './platform-model-selection';
import { publishProjectVisibility } from '../projects/operations/project-visibility';

/**
 * 真删一条会话。**人这一侧没有删除**(#6949,owner 2026-10-06):人和 agent 收起会话都只走归档。
 * 留下的调用方只有两类(#6949 评论里列了理由):
 *  - 回滚:spawn / 建会话半途失败,收掉从没交付出去的半建行(`skipTransportStop`:provider 从没启动);
 *  - 上级没了:roster 里删掉 agent、删自动化(删项目走 deleteProject,不经这里)—— 会话的上级都不在了,
 *    归档留下的是恢复不回来的孤儿行。
 * 只删这一条:它的子会话提升为根(见下面的事件)。
 *
 * 连同它挂着的一切:运行时挂载(会话进程、它的终端、ACP 那条腿)、附件文件、视图状态,以及
 * 只剩它在用的工作区行。工作目录本身不删(那是项目的工作副本,或用户自己的 worktree)。
 */
export async function deleteSession(
  projectId: string,
  sessionId: string,
  options: { skipTransportStop?: boolean } = {}
): Promise<void> {
  const skipTransportStop = options.skipTransportStop === true;
  const [convRow] = await db
    .select({
      type: sessions.runtime,
      providerSessionId: sessions.providerSessionId,
      workspaceId: sessions.workspaceId,
    })
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.projectId, projectId)))
    .limit(1);
  if (!convRow) return;

  const linkedChildren = await db
    .select({
      id: sessions.id,
      projectId: sessions.projectId,
      parentSessionId: sessions.parentSessionId,
      spawnedBySessionId: sessions.spawnedBySessionId,
    })
    .from(sessions)
    .where(
      or(
        eq(sessions.parentSessionId, sessionId),
        eq(sessions.spawnedBySessionId, sessionId)
      )
    );

  // 子会话提升为根,见下面的事件。
  await stopSessionRuntime(projectId, sessionId, convRow.type, 'terminate', skipTransportStop);

  if (convRow.workspaceId) await deleteWorkspaceIfUnused(convRow.workspaceId, sessionId);
  await deleteSessionAttachmentFiles(sessionId).catch((e: unknown) => {
    log.warn('deleteSession: attachment cleanup failed', { sessionId, error: String(e) });
  });

  await db
    .delete(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.projectId, projectId)));

  // @@@2503 会话没了,它记的 composer 模型选择也一起收掉(会话 id 不复用)。
  await forgetSessionPlatformModel(sessionId);
  void viewStateService.del(`session:${sessionId}`);
  void viewStateService.del(`session:${sessionId}:tabs`);
  void forgetSessionOutputs(sessionId);

  sessionEvents._emit('session:deleted', sessionId);
  events.emit(sessionDeletedChannel, { sessionId, projectId });
  for (const child of linkedChildren) {
    events.emit(sessionChangedChannel, {
      sessionId: child.id,
      projectId: child.projectId,
      changes: {
        ...(child.parentSessionId === sessionId && { parentSessionId: null }),
        ...(child.spawnedBySessionId === sessionId && {
          spawnedBySessionId: null,
        }),
      },
    });
  }
  // Keep the external-fork capture scan from resurrecting this session off its transcript.
  tombstoneDeletedSession([sessionId, convRow.providerSessionId]);
  await publishProjectVisibility(projectId);
}

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
