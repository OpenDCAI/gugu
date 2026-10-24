import { sessionLeaveDestination } from '@renderer/features/sessions/leave-session-view';
import { getSessionManagerStore } from '@renderer/features/sessions/stores/session-selectors';
import { projectPresence } from '@renderer/features/projects/project-presence';
import type { GuardResult } from '@renderer/app/view-registry';

/**
 * 任务视图的路由守卫。单独成文件是为了能直接测 —— 它是纯判断,不该为了跑一条判据去搭半个 React 树。
 *
 * ⚠️ 它跑的时机不是随便什么时候:导航时跑一次,冷启动恢复快照时跑一次。恢复那一次**项目还没挂载**,
 * sessionManager 还不存在,所以下面 `if (sessionManager)` 那层只能放行 —— 补跑的那一次在 project-manager
 * 里(任务加载完、provision 之前)。改这里之前先想清楚你依赖的数据那一刻在不在。
 */
export function sessionViewCanActivate(params: unknown): GuardResult {
  const projectId =
    typeof params === 'object' && params !== null
      ? (params as { projectId?: unknown }).projectId
      : undefined;
  const sessionId =
    typeof params === 'object' && params !== null
      ? (params as { sessionId?: unknown }).sessionId
      : undefined;
  if (typeof projectId !== 'string' || typeof sessionId !== 'string') {
    return { ok: false, redirect: 'home' };
  }
  // 项目「还不知道」(别的机器上的、那台的清单还没到)先放行:清单到了会再跑一次守卫(project-presence.ts)。
  if (projectPresence(projectId) === 'deleted') return { ok: false, redirect: 'home' };
  // 任务列表还没加载出来时(冷启动恢复快照那一刻,项目尚未挂载)这里只能放行 —— 所以项目挂载、
  // 任务加载完之后必须再跑一次 revalidate,由 project-manager 负责补那一次。
  const sessionManager = getSessionManagerStore(projectId);
  if (sessionManager) {
    const session = sessionManager.sessions.get(sessionId);
    // 归档任务不是一个目的地:它在侧栏没有行、也不会被自动 provision,停在它的视图上只剩一块
    // 什么都不画的空白。和「任务不存在」同样处理 —— 退回去,而不是让人对着空白。
    const archived = Boolean(session?.data.archivedAt);
    if (!session || archived) {
      const destination = sessionLeaveDestination(projectId);
      return { ok: false, redirect: destination.viewId, params: destination.params };
    }
  }
  return { ok: true };
}
