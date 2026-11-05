import { getSessionPageStore, getSessionView, sessionViewKind, sessionErrorMessage, projectMountErrorMessage } from '@renderer/features/sessions/stores/session-selectors';
import { getProjectStore } from '@renderer/features/projects/stores/project-selectors';
import { machineUnavailableLabel } from './machine-unavailable-label';
import { sessionTabKind } from './session-tab-kind';
import { whenSessionPaneReady } from './session-pane-ready';
import { offlineSessionInputTarget } from './offline-session-input-target';
import { sessionRegistry } from './stores/session-registry';
import { toast } from '@renderer/lib/hooks/use-toast';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { messageForUser } from '@/lib/userFacingError';
import { rememberTask } from '@renderer/features/command-palette/recent-tasks';

interface OpenSessionInSessionOptions {
  projectId: string;
  sessionId: string;
  /** Commit navigation or layout only after the task workspace can be opened. */
  onReady?: () => void;
  /**
   * behavior session-page「键盘导航」: keyboard ↑↓ walks the sidebar and the main area follows every
   * step, so those opens must reuse the pane's preview slot instead of stacking a permanent tab per
   * station — otherwise arrowing past ten conversations leaves ten tabs behind. Click/notification
   * opens stay permanent (the default).
   */
  preview?: boolean;
  /**
   * 只在这条会话一枚页签都没有时开(给屏上一块空着的会话补上对话)。会话就绪时存下的页签已经摆回来了 = 不动,
   * ❌ 把人停在别的页签上的那一枚抢成对话。
   */
  onlyIfNoTabs?: boolean;
  /** 群聊点不同 Agent：把会话作为已有右栏里的新页签打开。 */
  host?: { projectId: string; sessionId: string };
}

/**
 * Opens a conversation only after the owning task has a live workspace.
 *
 * A registered task already owns a WorkspaceViewModel, so waiting for `getSessionView()` alone races
 * cold-start provisioning: the ACP tab mounts first, reads a null workspaceId, and gets stuck on
 * "No workspace found for task". The provisioned task is the actual readiness boundary.
 */
export function openSessionInSessionWhenReady({
  projectId,
  sessionId,
  onlyIfNoTabs = false,
  host,
  onReady,
}: OpenSessionInSessionOptions): () => void {
  const kind = sessionViewKind(getSessionPageStore(projectId, sessionId), projectId);
  if (!onlyIfNoTabs && kind !== 'archived' && kind !== 'missing') rememberTask(sessionId);
  if (offlineSessionInputTarget(projectId, kind)) {
    // Navigation reaches the shared offline input without preparing a remote workspace.
    onReady?.();
    return () => {};
  }
  return whenSessionPaneReady(
    projectId,
    sessionId,
    () => {
      const session = sessionRegistry
        .get(sessionId)
        ?.sessions.get(sessionId);
      if (!session) return;
      const paneLayout = getSessionView(host?.projectId ?? projectId, host?.sessionId ?? sessionId)?.paneLayout;
      if (!onlyIfNoTabs || !paneLayout?.groups.some((g) => g.pane.tabOrder.length > 0)) {
        const existing = paneLayout?.groups.flatMap((group) => [...group.pane.entries.values()]
          .filter((entry) => entry.kind === sessionTabKind(session.data.runtime) && (entry.state as { sessionId?: string } | null)?.sessionId === sessionId)
          .map((entry) => ({ group, entry })))[0];
        if (existing) {
          paneLayout!.setActiveGroup(existing.group.paneId);
          existing.group.pane.setActiveTab(existing.entry.tabId);
          onReady?.();
          return;
        }
        paneLayout?.open(
          sessionTabKind(session.data.runtime),
          { sessionId, ...(host ? { projectId, ownerSessionId: sessionId } : {}) },
          { from: null, intent: 'newTab' }
        );
      }
      onReady?.();
    },
    {
      canOpen: () => {
        // The workspace can precede the registry's asynchronous conversation row on cold opens.
        const manager = sessionRegistry.get(sessionId);
        if (!manager?.sessions.get(sessionId)) {
          // Reading data starts the existing demand load, including before its reaction attaches.
          const data = manager?.list.data;
          if (manager?.list.error) return manager.list.error;
          if (manager && (data === null || manager.list.loading || data?.some(row => row.id === sessionId))) return undefined;
          return false;
        }
        if (host && !getSessionView(host.projectId, host.sessionId)) {
          const page = getSessionPageStore(host.projectId, host.sessionId);
          const kind = sessionViewKind(page, host.projectId);
          if (kind === 'project-error') return projectMountErrorMessage(host.projectId, translateSessionMessage);
          const failure = sessionErrorMessage(page, translateSessionMessage) ?? machineUnavailableLabel(host.projectId);
          if (failure) return failure;
          if (kind === 'creating' || kind === 'provisioning') return undefined;
          if (kind === 'project-mounting') {
            const project = getProjectStore(host.projectId);
            if (project?.phase === 'opening' || project?.mountedProject?.sessionManager.listState === 'reading') return undefined;
          }
          return false;
        }
        return Boolean(getSessionView(host?.projectId ?? projectId, host?.sessionId ?? sessionId));
      },
      onError: (reason) => {
        toast({
          title: translateSessionMessage('sidebar.conversationNotOpenable'),
          description: messageForUser(reason),
          variant: 'destructive',
          action: {
            label: translateSessionMessage('common.retry'),
            onClick: () => openSessionInSessionWhenReady({ projectId, sessionId, onlyIfNoTabs, host, onReady }),
          },
        });
      },
    }
  );
}
