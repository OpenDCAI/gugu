import { when } from 'mobx';
import { getSessionView } from '@renderer/features/sessions/stores/session-selectors';
import { sessionTabKind } from './session-tab-kind';
import { sessionPaneReady } from './session-pane-ready';
import { workspaceReachLabel } from './workspace-backend/workspace-surface';
import { sessionRegistry } from './stores/session-registry';
import { toast } from '@renderer/lib/hooks/use-toast';
import { translateSessionMessage } from '@renderer/localization/locale-store';

interface OpenSessionInSessionOptions {
  projectId: string;
  sessionId: string;
  timeout?: number;
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
  timeout = 10_000,
  preview = false,
  onlyIfNoTabs = false,
  host,
  onReady,
}: OpenSessionInSessionOptions): () => void {
  const paneReady = sessionPaneReady(projectId, sessionId, { reviveArchived: false });
  return when(
    () => {
      const session = sessionRegistry
        .get(sessionId)
        ?.sessions.get(sessionId);
      return Boolean(paneReady() && getSessionView(host?.projectId ?? projectId, host?.sessionId ?? sessionId) && session);
    },
    () => {
      const session = sessionRegistry
        .get(sessionId)
        ?.sessions.get(sessionId);
      if (!session) return;
      const paneLayout = getSessionView(host?.projectId ?? projectId, host?.sessionId ?? sessionId)?.paneLayout;
      if (onlyIfNoTabs && paneLayout?.groups.some((g) => g.pane.tabOrder.length > 0)) return;

      paneLayout?.open(
        sessionTabKind(session.data.runtime),
        { sessionId, ...(host ? { projectId, ownerSessionId: sessionId } : {}) },
        { preview }
      );
      onReady?.();
    },
    {
      timeout,
      onError: (error) => {
        console.error('[gugu] Timed out while opening a session-page session', {
          projectId,
          sessionId,
          error,
        });
        toast({
          title: translateSessionMessage('sidebar.conversationNotOpenable'),
          description: workspaceReachLabel(projectId) ?? translateSessionMessage('sidebar.workspaceNotReady'),
          variant: 'destructive',
        });
      },
    }
  );
}
