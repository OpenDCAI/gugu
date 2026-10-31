import { sessionService } from '@main/core/sessions/session-service';
import { archiveSession } from './archiveSession';

/**
 * #5665 / #6269 —— 派生出来的会话(`session_spawn`、扩展派活、分叉)各是一条独立的会话,工作目录取自来源会话:
 * 同一行 workspaces(挂载按引用计数,删会话走 `deleteWorkspaceIfUnused`)。
 *
 * 会话行落库之后挂载它:pty 会话起进程要一个挂着的运行时,ACP 启动要目录路径。挂载失败就把刚落的那一行撤掉
 * 再抛 —— ❌ 留一条起不来、也没人回收的会话。
 */
export async function mountSpawnedSession(
  projectId: string,
  sessionId: string
): Promise<{ workspaceId: string; path: string }> {
  try {
    const mounted = await sessionService.ensureSessionMounted(sessionId);
    return { workspaceId: mounted.workspaceId, path: mounted.path };
  } catch (error) {
    await archiveSession(projectId, sessionId, { skipTransportStop: true });
    throw error;
  }
}
