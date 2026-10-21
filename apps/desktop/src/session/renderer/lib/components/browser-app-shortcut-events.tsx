import { useEffect } from 'react';
import { getRegisteredSessionData, getSessionView } from '@renderer/features/sessions/stores/session-selectors';
import { zenFilePanel } from '@renderer/features/sessions/stores/workspace-panel-chrome-store';
import { commandRegistry } from '@renderer/lib/commands/registry';
import { events } from '@renderer/lib/ipc';
import {
  type WorkspaceLayoutContextValue,
  useWorkspaceLayoutContext,
} from '@renderer/lib/layout/layout-provider';
import { useParams, useWorkspaceSlots } from '@renderer/lib/layout/navigation-provider';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { browserAppShortcutChannel } from '@shared/events/appEvents';
import type { ShortcutSettingsKey } from '@shared/shortcuts';

export function BrowserAppShortcutEvents() {
  const showCommandPalette = useShowModal('commandPaletteModal');
  const { toggleLeft, toggleZenMode } = useWorkspaceLayoutContext();
  const { currentView } = useWorkspaceSlots();
  const { params: sessionParams } = useParams('session');
  const { params: projectParams } = useParams('project');

  const currentProjectId =
    currentView === 'session'
      ? sessionParams.projectId
      : currentView === 'project'
        ? projectParams.projectId
        : undefined;
  const currentSessionId = currentView === 'session' ? sessionParams.sessionId : undefined;

  useEffect(() => {
    return events.on(browserAppShortcutChannel, ({ shortcutKey }) => {
      if (commandRegistry.dispatch(shortcutKey)) return;

      dispatchAppOnlyShortcut(shortcutKey, {
        currentProjectId,
        currentSessionId,
        showCommandPalette,
        toggleLeft,
        toggleZenMode,
      });
    });
  }, [
    currentProjectId,
    currentSessionId,
    showCommandPalette,
    toggleLeft,
    toggleZenMode,
  ]);

  return null;
}

function dispatchAppOnlyShortcut(
  shortcutKey: ShortcutSettingsKey,
  context: {
    currentProjectId: string | undefined;
    currentSessionId: string | undefined;
    showCommandPalette: (input: {
      projectId?: string;
      sessionId?: string;
      workspaceId?: string;
    }) => void;
    toggleLeft: () => void;
    toggleZenMode: WorkspaceLayoutContextValue['toggleZenMode'];
  }
): void {
  switch (shortcutKey) {
    case 'openFile':
    case 'commandPalette': {
      const workspaceId =
        context.currentProjectId && context.currentSessionId
          ? (getRegisteredSessionData(context.currentProjectId, context.currentSessionId)?.workspaceId ??
            undefined)
          : undefined;

      context.showCommandPalette({
        projectId: context.currentProjectId,
        sessionId: context.currentSessionId,
        workspaceId,
      });
      break;
    }
    case 'toggleLeftSidebar':
      context.toggleLeft();
      break;
    case 'splitPane': {
      // ⌘\ 分屏 / 拆开(spec session-page「并排」):焦点在网页里时键被网页那边截下转到这里,❌ 只在咕咕自己的界面里才认。
      if (!context.currentProjectId || !context.currentSessionId) break;
      const pane = getSessionView(context.currentProjectId, context.currentSessionId)?.paneLayout.focusedPane;
      if (pane?.inSplitLayout) pane.toggleSplit();
      break;
    }
    case 'zenMode':
      context.toggleZenMode(zenFilePanel());
      break;
  }
}
