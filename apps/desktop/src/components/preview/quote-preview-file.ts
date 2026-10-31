import { stringifyMention } from '@gugu/session-shared/markdown';
import { composeInChat } from '@/session/shared/extensions/app-send-core';
import { APP_COMPOSE_EVENT } from '@/session/shared/extensions/app-runtime-protocol';
import type { FileViewerSelection } from '@/session/shared/preview/file-viewer-menu';
import { getRendererSession } from '@/lib/sessionPublication';

export function selectedTextQuote(selection: FileViewerSelection): string {
  return selection.text.split('\n').map((line) => `> ${line}`).join('\n');
}

export function selectionPosition(selection: FileViewerSelection): string {
  const at = selection.at;
  if (!at) return '';
  if (at.lines) return `L${at.lines}`;
  return '';
}

/** Use the App file-reference producer and its existing draft delivery, including membership and version checks. */
export async function quoteChatFile(itemId: string, version: number, selection: FileViewerSelection | null): Promise<void> {
  const session = getRendererSession();
  if (!session) throw new Error('Sign in to quote this file');
  const detail = await composeInChat({ account: async () => ({ token: session.access_token, userId: session.user.id }) }, {
    text: selection ? selectedTextQuote(selection) : '',
    refs: [{
      file: { id: itemId },
      version,
      ...(selection ? { at: selection.at, label: [selectionPosition(selection), selection.text].filter(Boolean).join(' · ') } : {}),
    }],
  });
  document.dispatchEvent(new CustomEvent(APP_COMPOSE_EVENT, { detail, bubbles: true }));
}

/** The same task-file reference text in desktop and phone composers. */
export function workspaceFileQuote(path: string, selection: FileViewerSelection | null): string {
  const name = path.replace(/\\/g, '/').split('/').pop() ?? path;
  const label = [name, selection && selectionPosition(selection)].filter(Boolean).join(' · ');
  const mention = stringifyMention({ label, target: path, kind: 'file' });
  return selection ? `${mention}\n${selectedTextQuote(selection)}` : mention;
}
