import type { SessionStore } from '@renderer/features/sessions/page-sessions-store';
import { sessionRegistry } from '@renderer/features/sessions/stores/session-registry';
import { isUnmountedProject } from '@renderer/features/projects/stores/project';
import { getProjectManagerStore } from '@renderer/features/projects/stores/project-selectors';
import type { DiffViewStore } from '@renderer/features/sessions/diff-view/stores/diff-view-store';
import type { EditorViewStore } from '@renderer/features/sessions/editor/stores/editor-view-store';
import type { AgentStatus, AgentStatusDetail } from '@shared/core/agents/agentEvents';
import type { Session } from '@shared/core/sessions/sessions';
import type { ProjectSessionsStore } from './project-sessions-store';
import {
  isProvisioned,
  isUnprovisioned,
  isUnregistered,
  registeredSessionData,
  type SessionPageStore,
} from './session-store';
import { terminalRegistry } from './terminal-registry';
import { workspaceRegistry } from './workspace-registry';
import type { WorkspaceViewModel } from './workspace-view-model';
import { describeSessionFailure, type SessionTranslate } from './session-failure-message';

/** Call only inside `observer` components (or other MobX reactions). */
export function getSessionManagerStore(projectId: string): ProjectSessionsStore | undefined {
  const p = getProjectManagerStore().projects.get(projectId);
  return p?.mountedProject?.sessionManager;
}

/** Call only inside `observer` components (or other MobX reactions). */
export function getSessionPageStore(projectId: string, sessionId: string): SessionPageStore | undefined {
  return getSessionManagerStore(projectId)?.sessions.get(sessionId);
}

/** The session record when it exists and is not unregistered; otherwise undefined. */
export function getRegisteredSessionData(projectId: string, sessionId: string): Session | undefined {
  const store = getSessionPageStore(projectId, sessionId);
  if (!store) return undefined;
  return registeredSessionData(store);
}

/** Call only inside `observer` components (or other MobX reactions). */
export function getSessionView(projectId: string, sessionId: string): WorkspaceViewModel | undefined {
  return getSessionPageStore(projectId, sessionId)?.viewModel ?? undefined;
}

/** Call only inside `observer` components (or other MobX reactions). */
export function getEditorView(projectId: string, sessionId: string): EditorViewStore | undefined {
  return getSessionView(projectId, sessionId)?.editorView;
}

/** Call only inside `observer` components (or other MobX reactions). */
export function getDiffView(projectId: string, sessionId: string): DiffViewStore | undefined {
  return getSessionView(projectId, sessionId)?.diffView ?? undefined;
}

export function getSessionGitWorktreeStore(projectId: string, sessionId: string) {
  const store = getSessionPageStore(projectId, sessionId);
  if (!store?.workspaceId) return undefined;
  return workspaceRegistry.get(projectId, store.workspaceId)?.gitWorktree;
}

export function sessionAgentStatus(store: SessionPageStore): AgentStatus | null {
  const mgr = sessionRegistry.get(store.data.id);
  return mgr?.sessionStatus ?? null;
}

/** `sessionAgentStatus` 那一格的附属态(只改画法与那一句)。 */
export function sessionAgentStatusDetail(store: SessionPageStore): AgentStatusDetail | null {
  const mgr = sessionRegistry.get(store.data.id);
  return mgr?.sessionStatusDetail ?? null;
}

// @@@sessionpage otty-state — the session's conversation rows (the session itself), ordered by lastInteractedAt
// desc; this is the enumeration the sidebar buckets from.
export function pageSessions(store: SessionPageStore): SessionStore[] {
  const mgr = sessionRegistry.get(store.data.id);
  if (!mgr) return [];
  return Array.from(mgr.sessions.values()).sort((a, b) => {
    const aTime = a.data.lastInteractedAt ? new Date(a.data.lastInteractedAt).getTime() : 0;
    const bTime = b.data.lastInteractedAt ? new Date(b.data.lastInteractedAt).getTime() : 0;
    return bTime - aTime;
  });
}

export type SessionViewKind =
  | 'missing'
  | 'project-mounting' // project is still opening — task data not yet available
  | 'project-error' // project failed to open
  | 'creating'
  | 'create-error'
  | 'provisioning'
  | 'provision-error'
  | 'idle'
  | 'archived'
  | 'ready';

/**
 * Derives the task view kind from the project + task store state.
 *
 * Pass `projectId` so that "project still opening" can be distinguished from
 * "task genuinely missing". Call only inside `observer` components.
 */
export function sessionViewKind(store: SessionPageStore | undefined, projectId: string): SessionViewKind {
  const projectStore = getProjectManagerStore().projects.get(projectId);

  if (!projectStore) return 'missing';

  if (isUnmountedProject(projectStore)) {
    if (projectStore.phase === 'opening') return 'project-mounting';
    if (projectStore.phase === 'error') return 'project-error';
    return 'project-mounting';
  }

  if (projectStore.state === 'unregistered') return 'missing';

  // 项目挂上了、会话列表还在读:这条还没进列表,❌ 判成 missing(会闪一下「找不到」)。
  if (!store) return projectStore.mountedProject?.sessionManager.listState === 'reading' ? 'project-mounting' : 'missing';

  if (isUnregistered(store)) {
    if (store.phase === 'creating') return 'creating';
    return 'create-error';
  }
  if (isUnprovisioned(store)) {
    if (store.phase === 'provision') {
      return 'provisioning';
    }
    if (store.phase === 'provision-error') return 'provision-error';
    // 归档是自己一档,❌ 混进 idle。归档后的 task 落在 unprovisioned 且没有任何在途阶段,而自动
    // provision 明确跳过归档任务,于是 idle 那一档的「正在准备文件…」在这里永远转不完 —— 一个没人
    // 在准备的状态不该画成正在准备。这一档是唯一的判据,view.tsx 不再各判一次。
    // 判在这里而不是函数开头:archiveSession 先乐观写下 `archivedAt` 再发 RPC,那一小段里 task 还挂着
    // workspace、视图仍是 ready;搬到开头会让它当场闪一下「已归档」,归档失败回滚时再闪回来。
    if (store.data.archivedAt) return 'archived';
    return 'idle';
  }
  return 'ready';
}

/** Returns the narrowed provisioned task store if the task is provisioned, otherwise undefined. */
export function asProvisioned(
  store: SessionPageStore | undefined
): (SessionPageStore & { state: 'provisioned'; workspaceId: string }) | undefined {
  return store && isProvisioned(store) ? store : undefined;
}

// ---------------------------------------------------------------------------
// New focused selectors (Phase 4)
// ---------------------------------------------------------------------------

export function getWorkspaceForSession(projectId: string, sessionId: string) {
  const wsId = getSessionPageStore(projectId, sessionId)?.workspaceId;
  return wsId ? (workspaceRegistry.get(projectId, wsId) ?? undefined) : undefined;
}

export function getWorkspaceViewModel(
  projectId: string,
  sessionId: string
): WorkspaceViewModel | undefined {
  return getSessionPageStore(projectId, sessionId)?.viewModel ?? undefined;
}

export function getPageSessions(sessionId: string) {
  return sessionRegistry.get(sessionId);
}

export function getTerminalsForSession(sessionId: string) {
  return terminalRegistry.get(sessionId);
}

/** Returns the display name from any task store variant. */
export function sessionDisplayName(store: SessionPageStore | undefined): string | undefined {
  if (!store) return undefined;
  return store.displayName;
}

export { describeSessionFailure };

/** Returns the error message for error states. */
export function sessionErrorMessage(
  store: SessionPageStore | undefined,
  translate: SessionTranslate
): string | undefined {
  if (!store) return undefined;
  if (isUnregistered(store) && store.phase === 'create-error') {
    return store.failure
      ? describeSessionFailure(store.failure, translate)
      : translate('task.createTaskFailed');
  }
  if (isUnprovisioned(store)) {
    if (store.phase === 'provision-error') {
      return store.failure
        ? describeSessionFailure(store.failure, translate)
        : translate('task.setUpWorkspaceFailed');
    }
  }
  return undefined;
}

/** Returns the mount error message for the project. */
export function projectMountErrorMessage(projectId: string, translate: SessionTranslate): string {
  const store = getProjectManagerStore().projects.get(projectId);
  // store.error 是主进程原样抛回的诊断，逐字返回；缺席时才落到本地化外壳。
  if (store && isUnmountedProject(store) && store.phase === 'error') {
    return store.error ?? translate('task.openProjectFailed');
  }
  return translate('task.openProjectFailed');
}
