import { observer } from 'mobx-react-lite';
import { createContext, useContext, type ReactNode } from 'react';
import { BrowserUseAutoOpen } from '@/components/browserUse/BrowserUseAutoOpen';
import type { PageSessionsStore } from '@renderer/features/sessions/page-sessions-store';
import {
  getPageSessions,
  getSessionPageStore,
  getTerminalsForSession,
  getWorkspaceForSession,
  sessionViewKind,
  type SessionViewKind,
} from '@renderer/features/sessions/stores/session-selectors';
import type { WorkspaceStore } from '@renderer/features/sessions/stores/workspace';
import type { WorkspaceViewModel } from '@renderer/features/sessions/stores/workspace-view-model';
import type { TerminalManagerStore } from '@renderer/features/sessions/terminals/terminal-manager';
import type { WorkspaceSurface, WorkspaceSurfaceWorkspace } from './workspace-backend/workspace-surface';

interface SessionViewContext {
  projectId: string;
  sessionId: string;
  /** The workspace ID for this task, or null when not yet registered. */
  workspaceId: string | null;
}

const SessionViewContext = createContext<SessionViewContext | null>(null);

export const SessionViewWrapper = observer(function SessionViewWrapper({
  children,
  projectId,
  sessionId,
}: {
  children: ReactNode;
  projectId: string;
  sessionId: string;
}) {
  const workspaceId = getSessionPageStore(projectId, sessionId)?.workspaceId ?? null;
  return (
    <SessionViewContext.Provider value={{ projectId, sessionId, workspaceId }}>
      {children}
      {/* 任务在咕咕 server 上、它的浏览器开始干活:Browser Use 页签替人加到页签条上一次(不切过去)。 */}
      <BrowserUseAutoOpen sessionId={sessionId} />
    </SessionViewContext.Provider>
  );
});

/** 这条会话的工作区状态(本机与别的机器上的会话是同一种)。 */
export function getWorkspaceSurface(projectId: string, sessionId: string): WorkspaceSurface | undefined {
  return getSessionPageStore(projectId, sessionId)?.viewModel ?? undefined;
}

/**
 * 会话右侧工作区的共用组件用这个(文件、树、审阅、diff、浏览器、终端)—— 不管会话在哪台机器上。
 * 聊天栏那些只有本机任务才有的东西仍用 useWorkspaceViewModel。
 */
export function useWorkspaceSurface(): WorkspaceSurface {
  const { projectId, sessionId } = useSessionViewContext();
  const surface = getWorkspaceSurface(projectId, sessionId);
  if (!surface) throw new Error('useWorkspaceSurface: session is not registered (no view model)');
  return surface;
}

export function useSessionViewContext(): SessionViewContext {
  const context = useContext(SessionViewContext);
  if (!context) {
    throw new Error('useSessionViewContext must be used within a SessionViewContextProvider');
  }
  return context;
}

export function useSessionViewKind(): SessionViewKind {
  const { projectId, sessionId } = useSessionViewContext();
  return sessionViewKind(getSessionPageStore(projectId, sessionId), projectId);
}

/** Returns the active workspace (path + git). Throws if the task is not provisioned. */
export function useWorkspace(): WorkspaceSurfaceWorkspace {
  const { projectId, sessionId } = useSessionViewContext();
  const workspace = getWorkspaceForSession(projectId, sessionId);
  if (!workspace) {
    throw new Error('useWorkspace: session is not provisioned (no workspace)');
  }
  return workspace;
}

/** 本机任务的工作区(含本机才有的生命周期脚本);只给本机才有的界面(终端抽屉)用。 */
export function useLocalWorkspace(): WorkspaceStore {
  const { projectId, sessionId } = useSessionViewContext();
  const workspace = getWorkspaceForSession(projectId, sessionId);
  if (!workspace) throw new Error('useLocalWorkspace: session is not provisioned (no workspace)');
  return workspace;
}

/** Returns the workspace ID. Throws if the task has no workspace yet. */
export function useWorkspaceId(): string {
  const { workspaceId } = useSessionViewContext();
  if (!workspaceId) throw new Error('useWorkspaceId: session has no workspace');
  return workspaceId;
}

/** Returns the WorkspaceViewModel. Throws if the task is not registered. */
export function useWorkspaceViewModel(): WorkspaceViewModel {
  const { projectId, sessionId } = useSessionViewContext();
  const viewModel = getSessionPageStore(projectId, sessionId)?.viewModel;
  if (!viewModel) {
    throw new Error('useWorkspaceViewModel: session is not registered (no view model)');
  }
  return viewModel;
}

/** Returns the PageSessionsStore for the task. Throws if not registered. */
export function useSessions(): PageSessionsStore {
  const { sessionId } = useSessionViewContext();
  const mgr = getPageSessions(sessionId);
  if (!mgr) {
    throw new Error('useSessions: session is not registered (no session manager)');
  }
  return mgr;
}

/** Returns the TerminalManagerStore for the task. Throws if not registered. */
export function useTerminals(): TerminalManagerStore {
  const { sessionId } = useSessionViewContext();
  const mgr = getTerminalsForSession(sessionId);
  if (!mgr) {
    throw new Error('useTerminals: session is not registered (no terminal manager)');
  }
  return mgr;
}
