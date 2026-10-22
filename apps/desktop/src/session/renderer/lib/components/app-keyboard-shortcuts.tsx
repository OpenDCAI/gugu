import { useHotkey } from '@tanstack/react-hotkeys';
import { useObserver } from 'mobx-react-lite';
import { useEffect } from 'react';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
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
  const { exitZenMode, toggleLeft, toggleZenMode } = useWorkspaceLayoutContext();

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

  // gugu-dev#181 ⑯ 一个 ⌘K:会话、项目、对话、话题、操作、文件在同一个面板里搜(⌘P 也是它)。
  const openPalette = () =>
    showCommandPalette({
      projectId: currentProjectId,
      sessionId: currentSessionId,
      workspaceId: currentWorkspaceId,
    });
  useHotkey(getHotkeyRegistration('commandPalette', keyboard), openPalette, {
    enabled: commandPaletteHotkey !== null,
  });
  useHotkey(getHotkeyRegistration('openFile', keyboard), openPalette, {
    enabled: openFileHotkey !== null,
  });

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
