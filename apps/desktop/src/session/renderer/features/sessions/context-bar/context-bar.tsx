import { observer } from 'mobx-react-lite';
import { useMemo, useState, type ReactNode } from 'react';
import { usePromptLibrary } from '@renderer/features/library/prompts/use-prompt-library';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { usePaneContext } from '@renderer/features/tabs/pane-context';
import { getRegisteredSessionData } from '@renderer/features/sessions/stores/session-selectors';
import {
  useSessions,
  useSessionViewContext,
  useWorkspaceViewModel,
} from '@renderer/features/sessions/session-view-context';
import { rpc } from '@renderer/lib/ipc';
import { pastePromptInjection } from '@renderer/lib/pty/prompt-injection';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@renderer/lib/ui/context-menu';
import { AddContextPopover } from '../context-bar/add-context-popover';
import { buildSessionContextActions, type ContextAction } from '../context-bar/context-actions';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

interface ContextBarProps {
  sessionId: string | undefined;
  hideTrigger?: boolean;
  /** 同一行「添加上下文」左边的东西(这个任务的定时芯片)。这一行被隐藏时它自己撑起这一行,❌ 跟着消失。 */
  leading?: ReactNode;
}

export const ContextBar = observer(function ContextBar({
  sessionId,
  hideTrigger = false,
  leading = null,
}: ContextBarProps) {
  const { translate } = useSessionMessages();
  const { projectId, sessionId: pageSessionId } = useSessionViewContext();
  const { paneId } = usePaneContext();
  const sessionView = useWorkspaceViewModel();
  const sessions = useSessions();
  const { update: updateInterfaceSettings, isSaving: isSavingInterfaceSettings } =
    useAppSettingsKey('interface');
  const session = getRegisteredSessionData(projectId, pageSessionId);
  const { value: promptLibrary, isSaving: isSavingPromptLibrary } = usePromptLibrary();
  const activeSession = sessionId ? sessions.ptySessions.get(sessionId) : undefined;
  const activeSessionStore = sessionId
    ? sessions.sessions.get(sessionId)
    : undefined;
  const activeSessionId = activeSession?.ptySessionId;
  const canApplyContext = Boolean(activeSessionId);
  const hasSession = sessions.sessions.size > 0;
  const [menuOpen, setMenuOpen] = useState(false);

  const actions = useMemo(
    () => buildSessionContextActions(session?.linkedIssue, promptLibrary),
    [session?.linkedIssue, promptLibrary]
  );

  const isActivePane = sessionView.paneLayout.activePaneId === paneId;
  const hasVisibleContextBar = Boolean(hasSession && actions.length > 0);
  const popoverActions = canApplyContext ? actions : [];

  const handleApplyAction = async (
    text: string,
    action: ContextAction,
    opts?: { andSend?: boolean }
  ) => {
    if (!activeSessionId || !text) return;

    await pastePromptInjection({
      providerId: activeSessionStore?.data.providerId,
      text,
      forceBracketedPaste: true,
      sendInput: (data) => rpc.pty.sendInput(activeSessionId, data),
    });

    if (opts?.andSend) {
      await rpc.pty.sendInput(activeSessionId, '\r');
    }

    activeSession?.pty?.terminal.focus();
  };

  const hideContextBar = () => {
    updateInterfaceSettings({ hideContextBar: true });
    setMenuOpen(false);
  };

  const contextPopover = (
    <AddContextPopover
      actions={hideTrigger ? popoverActions : actions}
      disabled={!canApplyContext || isSavingPromptLibrary}
      emptyMessage={canApplyContext ? undefined : translate('contextBar.noActiveSession')}
      hideTrigger={hideTrigger}
      hotkeyEnabled={hideTrigger ? true : undefined}
      isActivePane={isActivePane}
      onApplyAction={handleApplyAction}
      side="top"
    />
  );

  // h-8 = 这一行只有芯片时也和带「添加上下文」时一样高。
  const rowClassName = 'flex h-8 w-full items-center justify-center gap-2 bg-background-secondary-1 px-4 pb-2';
  const leadingRow = leading ? <div className={rowClassName}>{leading}</div> : null;

  if (hideTrigger) {
    return (
      <>
        {leadingRow}
        <div className="relative h-0 w-full overflow-visible">{contextPopover}</div>
      </>
    );
  }

  if (!hasVisibleContextBar) return leadingRow;

  return (
    <ContextMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <ContextMenuTrigger>
        <div className={rowClassName}>
          {leading}
          <div className="shrink-0">{contextPopover}</div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent finalFocus={false}>
        <ContextMenuItem disabled={isSavingInterfaceSettings} onClick={hideContextBar}>
          {translate('contextBar.hide')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});
