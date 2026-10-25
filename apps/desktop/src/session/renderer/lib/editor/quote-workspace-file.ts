import { stringifyMention } from '@gugu/session-shared/markdown';
import { selectedTextQuote, selectionPosition } from '@/components/preview/quote-preview-file';
import type { FileViewerSelection } from '@shared/preview/file-viewer-menu';
import { getSessionView } from '@renderer/features/sessions/stores/session-selectors';
import { composeInSession } from '@renderer/features/extensions/compose-in-session';
import { findConversationAnchor } from '@renderer/features/sessions/view/session-pane-policy';

/** Keep the file path on its source task's existing draft/terminal route, including remote workspaces. */
export async function quoteWorkspaceFile(projectId: string, sessionId: string, path: string, selection: FileViewerSelection | null): Promise<void> {
  const view = getSessionView(projectId, sessionId);
  if (!view) throw new Error('The task that opened this file is no longer open');
  const name = path.replace(/\\/g, '/').split('/').pop() ?? path;
  const label = [name, selection && selectionPosition(selection)].filter(Boolean).join(' · ');
  const mention = stringifyMention({ label, target: path, kind: 'file' });
  const anchor = findConversationAnchor(view.paneLayout, sessionId);
  if (anchor) {
    view.paneLayout.setActiveGroup(anchor.paneId);
    view.paneLayout.groups.find(group => group.paneId === anchor.paneId)?.pane.setActiveTab(anchor.tabId);
  }
  await composeInSession(view, selection ? `${mention}\n${selectedTextQuote(selection)}` : mention);
}
