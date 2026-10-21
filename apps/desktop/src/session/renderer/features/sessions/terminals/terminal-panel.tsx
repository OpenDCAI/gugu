import { Terminal } from '@/lib/icons'
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { useTabShortcuts } from '@renderer/features/tabs/hooks/useTabShortcuts';
import {
  useSessionViewContext,
  useTerminals,
  useLocalWorkspace,
  useWorkspaceId,
  useWorkspaceViewModel,
} from '@renderer/features/sessions/session-view-context';
import {
  DEFAULT_TERMINAL_SHELL_AVAILABILITY,
  useTerminalShellAvailability,
} from '@renderer/lib/hooks/use-terminal-shell-availability';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { EmptyState } from '@renderer/lib/ui/empty-state';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@renderer/lib/ui/resizable';
import { BoundShortcut } from '@renderer/lib/ui/shortcut';
import type { TerminalShellId } from '@shared/core/terminals/terminal-settings';
import { useIsActiveSession } from '../hooks/use-is-active-session';
import { TerminalDrawerSidebar } from './terminal-drawer-sidebar';
import { resolveTerminalPanelActiveItem } from './terminal-panel-selection';
import { TerminalPtyContent } from './terminal-pty-content';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

export const TerminalsPanel = observer(function TerminalsPanel() {
  const { projectId, sessionId } = useSessionViewContext();
  const { translate } = useSessionMessages();
  const workspaceId = useWorkspaceId();
  const sessionView = useWorkspaceViewModel();
  const workspace = useLocalWorkspace();
  const terminalMgr = useTerminals();
  const terminalTabView = sessionView.terminalTabs;
  const lifecycleScriptsMgr = workspace.lifecycleScripts ?? null;
  const isActive = useIsActiveSession(sessionId);
  const [isPanelFocused, setIsPanelFocused] = useState(false);
  const [shouldLoadShellAvailability, setShouldLoadShellAvailability] = useState(false);
  const { data: shellAvailability = DEFAULT_TERMINAL_SHELL_AVAILABILITY } =
    useTerminalShellAvailability({ enabled: shouldLoadShellAvailability });

  const autoFocus =
    isActive && sessionView.isTerminalDrawerOpen && sessionView.focusedRegion === 'bottom';

  const terminalTabs = terminalTabView.tabs;
  const lifecycleScriptTabs = lifecycleScriptsMgr?.tabs ?? [];
  const terminalIdsOpenInMain = new Set<string>();
  for (const group of sessionView.paneLayout.groups) {
    for (const entry of group.pane.entries.values()) {
      if (entry.kind !== 'terminal') continue;
      const terminalId = (entry.state as { terminalId?: unknown }).terminalId;
      if (typeof terminalId === 'string') terminalIdsOpenInMain.add(terminalId);
    }
  }

  // Unified active item — spans both terminals and scripts sections.
  const activeItem = resolveTerminalPanelActiveItem({
    requestedActiveItem: sessionView.terminalDrawerActiveItem,
    activeTerminalId: terminalTabView.activeTabId,
    terminalIds: terminalTabs.map((terminal) => terminal.data.id),
    scriptIds: lifecycleScriptTabs.map((script) => script.data.id),
  });

  const activeTerminalId = activeItem.kind === 'terminal' ? activeItem.id : undefined;
  const activeTerminalIsOpenInMain =
    activeTerminalId !== undefined && terminalIdsOpenInMain.has(activeTerminalId);

  const activeSession =
    activeItem.kind === 'terminal'
      ? activeTerminalIsOpenInMain
        ? null
        : (terminalMgr.sessions.get(activeTerminalId ?? '') ?? null)
      : (lifecycleScriptTabs.find((s) => s.data.id === activeItem.id)?.session ?? null);

  const allPtySessionIds = [
    ...terminalTabs
      .filter((t) => !terminalIdsOpenInMain.has(t.data.id))
      .map((t) => terminalMgr.sessions.get(t.data.id)?.ptySessionId)
      .filter((id): id is string => Boolean(id)),
    ...lifecycleScriptTabs.map((s) => s.session.ptySessionId),
  ];

  const handleHoverTerminal = (id: string) => {
    const session = terminalMgr.sessions.get(id);
    if (session?.status === 'disconnected') void session.connect();
  };

  const activeStore =
    activeItem.kind === 'terminal' ? terminalTabView : (lifecycleScriptsMgr ?? undefined);
  useTabShortcuts(activeStore, { focused: isPanelFocused && isActive });

  const handleCreate = async (shell?: TerminalShellId) => {
    await sessionView.openNewTerminal(shell);
  };

  const handleRunScript = (id: string) => {
    const script = lifecycleScriptsMgr?.tabs.find((s) => s.data.id === id);
    if (!script || script.isRunning) return;
    lifecycleScriptsMgr?.setActiveTab(id);
    sessionView.setTerminalDrawerActiveItem({ kind: 'script', id });
    void rpc.terminals
      .runLifecycleScript({
        projectId,
        workspaceId,
        type: script.data.type,
      })
      .catch(() => {});
  };

  const handleStopScript = (id: string) => {
    const script = lifecycleScriptsMgr?.tabs.find((s) => s.data.id === id);
    if (!script) return;
    void rpc.terminals.stopLifecycleScript({
      projectId,
      workspaceId,
      type: script.data.type,
    });
  };

  const emptyState = (
    <EmptyState
      icon={<Terminal className="text-foreground-muted h-5 w-5" />}
      label={activeTerminalIsOpenInMain ? 'Terminal open in main pane' : 'No terminals yet'}
      description={
        activeTerminalIsOpenInMain
          ? 'Select the terminal tab in the main pane or create another terminal.'
          : "Add a terminal to run shell commands in this task's working directory."
      }
      action={
        activeTerminalIsOpenInMain ? undefined : (
          <Button
            size="sm"
            variant="outline"
            onClick={() => void handleCreate()}
            className="flex items-center gap-2"
          >
            {translate('session.newTerminal')}
            <BoundShortcut settingsKey="newTerminal" variant="keycaps" />
          </Button>
        )
      }
    />
  );

  return (
    <ResizablePanelGroup
      orientation="horizontal"
      id="terminal-drawer-inner"
      className="h-full"
      onFocus={() => {
        setIsPanelFocused(true);
        sessionView.setFocusedRegion('bottom');
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
          setIsPanelFocused(false);
        }
      }}
    >
      <ResizablePanel id="terminal-drawer-pty" minSize="30%">
        <TerminalPtyContent
          className="h-full"
          activeSession={activeSession}
          allPtySessionIds={allPtySessionIds}
          autoFocus={autoFocus}
          emptyState={emptyState}
          workspaceId={workspaceId}
        />
      </ResizablePanel>
      <ResizableHandle className="bg-transparent hover:bg-row-hover" />
      <ResizablePanel id="terminal-drawer-sidebar" defaultSize="25%" minSize="150px" maxSize="50%">
        <TerminalDrawerSidebar
          className="h-full"
          lifecycleScriptsMgr={lifecycleScriptsMgr}
          activeScriptId={activeItem.kind === 'script' ? activeItem.id : undefined}
          onSelectScript={(id) => {
            lifecycleScriptsMgr?.setActiveTab(id);
            sessionView.setTerminalDrawerActiveItem({ kind: 'script', id });
          }}
          onRunScript={handleRunScript}
          onStopScript={handleStopScript}
          terminalTabView={terminalTabView}
          activeTerminalId={activeTerminalId}
          shellAvailability={shellAvailability}
          onShellMenuOpen={() => setShouldLoadShellAvailability(true)}
          onSelectTerminal={(id) => {
            terminalTabView.setActiveTab(id);
            sessionView.setTerminalDrawerActiveItem({ kind: 'terminal', id });
          }}
          onAddTerminal={(shell) => void handleCreate(shell)}
          onRemoveTerminal={(id) => terminalTabView.removeTab(id)}
          onRenameTerminal={(id, name) => void terminalMgr?.renameTerminal(id, name)}
          onHoverTerminal={handleHoverTerminal}
        />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
});
