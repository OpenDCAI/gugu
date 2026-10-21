import { useHotkey } from '@tanstack/react-hotkeys';
import { useObserver } from 'mobx-react-lite';
import { useEffect } from 'react';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { sidebarSearchFocus } from '@renderer/features/sidebar/sidebar-search-trigger';
import { getRegisteredSessionData } from '@renderer/features/sessions/stores/session-selectors';
import { zenFilePanel } from '@renderer/features/sessions/stores/workspace-panel-chrome-store';
import {
  getEffectiveHotkey,
  getHotkeyRegistration,
} from '@renderer/lib/hooks/useKeyboardShortcuts';
import { useWorkspaceLayoutContext } from '@renderer/lib/layout/layout-provider';
import {
  useParams,
  useWorkspaceSlots,
} from '@renderer/lib/layout/navigation-provider';
import { useShowModal } from '@renderer/lib/modal/modal-provider';

export function AppKeyboardShortcuts() {
  const { value: keyboard } = useAppSettingsKey('keyboard');
  const showCommandPalette = useShowModal('commandPaletteModal');
  const { exitZenMode, isLeftOpen, setCollapsed, toggleLeft, toggleZenMode } =
    useWorkspaceLayoutContext();

  const commandPaletteHotkey = getEffectiveHotkey('commandPalette', keyboard);
  const openFileHotkey = getEffectiveHotkey('openFile', keyboard);
  const toggleLeftSidebarHotkey = getEffectiveHotkey('toggleLeftSidebar', keyboard);
  const zenModeHotkey = getEffectiveHotkey('zenMode', keyboard);

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

  const currentWorkspaceId = useObserver(() => {
    if (!currentProjectId || !currentSessionId) return undefined;
    return getRegisteredSessionData(currentProjectId, currentSessionId)?.workspaceId ?? undefined;
  });

  useEffect(() => () => exitZenMode(), [currentProjectId, currentSessionId, currentView, exitZenMode]);

  // spec session-page 链8: ⌘K focuses the sidebar's in-place search filter (opening the
  // sidebar first if collapsed). The command palette stays on ⌘P / menu entries.
  useHotkey(
    getHotkeyRegistration('commandPalette', keyboard),
    () => {
      if (!isLeftOpen) setCollapsed('left', false);
      requestAnimationFrame(() => sidebarSearchFocus.current?.());
    },
    { enabled: commandPaletteHotkey !== null }
  );

  useHotkey(
    getHotkeyRegistration('openFile', keyboard),
    () =>
      showCommandPalette({
        projectId: currentProjectId,
        sessionId: currentSessionId,
        workspaceId: currentWorkspaceId,
      }),
    { enabled: openFileHotkey !== null }
  );

  useHotkey(getHotkeyRegistration('toggleLeftSidebar', keyboard), () => toggleLeft(), {
    enabled: toggleLeftSidebarHotkey !== null,
  });

  useHotkey(
    getHotkeyRegistration('zenMode', keyboard),
    () => toggleZenMode(zenFilePanel()),
    { enabled: zenModeHotkey !== null, ignoreInputs: true }
  );

  return null;
}
