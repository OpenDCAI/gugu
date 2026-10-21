import { when } from 'mobx';
import { appendToDraft } from '@/store/chatContext';
import { findAcpChatStore } from '@renderer/features/sessions/acp/acp-chat-resource-manager';
import { focusSessionComposer } from '@renderer/features/sidebar/session-keyboard-nav';
import { getPageSessions } from '@renderer/features/sessions/stores/session-selectors';
import type { WorkspaceViewModel } from '@renderer/features/sessions/stores/workspace-view-model';
import { activeChatSessionId } from '@renderer/features/sessions/view/session-pane-policy';
import { rpc } from '@renderer/lib/ipc';
import { pastePromptInjection } from '@renderer/lib/pty/prompt-injection';

/** `gugu.compose` on a session page: a chat panel's draft (`setDraftText`, as a restored prompt), or a terminal's input line
 *  (pasted, not entered, as the context bar does); the chat column comes back from full width, focused. */
/** The same, into a session main has just brought on screen: once its view shows an open conversation (10 s at most). */
export async function composeWhenOpen(find: () => WorkspaceViewModel | undefined, text: string): Promise<void> {
  try {
    await when(() => {
      const view = find();
      return Boolean(view && activeChatSessionId(view.paneLayout));
    }, { timeout: 10_000 });
  } catch {
    throw new Error('That session did not open its conversation here');
  }
  const view = find();
  if (!view) throw new Error('That session is no longer open');
  await composeInSession(view, text);
}

export async function composeInSession(view: WorkspaceViewModel, text: string): Promise<void> {
  const sessionId = activeChatSessionId(view.paneLayout);
  if (!sessionId) throw new Error('No conversation is open in this session');
  view.setFocusedRegion('main');
  const chat = findAcpChatStore(sessionId);
  if (chat) {
    chat.setDraftText(appendToDraft(chat.draftText, text));
    // After the editor has taken the draft (and the chat column is back).
    requestAnimationFrame(() => focusSessionComposer());
    return;
  }
  // Every conversation has a terminal session; only a terminal one has it connected.
  const sessions = getPageSessions(view.sessionId);
  const session = sessions?.ptySessions.get(sessionId);
  const terminal = session?.pty;
  if (!session || !terminal) throw new Error('The conversation open in this session is not running');
  await pastePromptInjection({
    providerId: sessions?.sessions.get(sessionId)?.data.providerId,
    text,
    forceBracketedPaste: true,
    sendInput: (data) => rpc.pty.sendInput(session.ptySessionId, data),
  });
  terminal.terminal.focus();
}
