import { useEffect } from 'react';
import { zenFilePanel } from '@renderer/features/sessions/stores/workspace-panel-chrome-store';
import { useCommandProvider } from '@renderer/lib/commands/use-command-provider';
import { useWorkspaceLayoutContext } from '@renderer/lib/layout/layout-provider';
import {
  useParams,
  useWorkspaceSlots,
} from '@renderer/lib/layout/navigation-provider';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { useGlobalSearchV3 } from '@renderer/features/global-search/global-search-flag';
import { takeGlobalSearchOpen } from '@renderer/features/global-search/search-session';

export function AppKeyboardShortcuts() {
  const showCommandPalette = useShowModal('commandPaletteModal');
  const showGlobalSearch = useShowModal('globalSearchModal');
  const globalSearch = useGlobalSearchV3();
  const { exitZenMode, toggleLeft, toggleZenMode } = useWorkspaceLayoutContext();

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

  useEffect(() => () => exitZenMode(), [currentProjectId, currentSessionId, currentView, exitZenMode]);

  const openPalette = (initialQuery: string) => showCommandPalette({
    initialQuery,
  });
  useCommandProvider({
    scopeId: 'app',
    getCommands: () => [
      { id: 'app.quickSwitcher', execute: () => openPalette('') },
      { id: 'app.commandPalette', execute: () => openPalette('> ') },
      // Off: the command is absent, so Mod+Shift+F does nothing new. Entry points set the query in search-session first.
      ...(globalSearch ? [{ id: 'app.globalSearch' as const, execute: () => { takeGlobalSearchOpen(); showGlobalSearch({}) } }] : []),
      { id: 'app.toggleLeftSidebar', execute: toggleLeft },
      { id: 'app.zenMode', execute: () => toggleZenMode(zenFilePanel()) },
    ],
  });
  return null;
}
