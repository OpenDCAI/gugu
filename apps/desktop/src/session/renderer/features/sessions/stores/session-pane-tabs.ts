import type { SessionPaneTab } from '@gugu/session-core/session-record/contract';
import { asProvisioned, getSessionPageStore } from './session-selectors';
import type { PaneStore } from '@renderer/features/tabs/pane-store';
import { fileBaseName } from './workspace-path';
import { CHAT_TAB_KINDS } from '../view/session-pane-policy';

type Pane = Pick<PaneStore, 'entries' | '_resources' | 'requestCloseTabs'>;
type Layout = { groups: readonly { pane: Pane }[]; windowPanes: ReadonlyMap<string, { pane: Pane }> };
const panesOf = (layout: Layout) => [...layout.groups, ...layout.windowPanes.values()].map(({ pane }) => pane);
const isConversation = (kind: string) => CHAT_TAB_KINDS.has(kind) || kind === 'side-chat';

export function readSessionPaneTabs(projectId: string, sessionId: string): SessionPaneTab[] {
  const view = asProvisioned(getSessionPageStore(projectId, sessionId))?.viewModel;
  if (!view) throw new Error('target session pane is unavailable');
  return sessionPaneTabs(view.paneLayout);
}

export function sessionPaneTabs(layout: Layout): SessionPaneTab[] {
  return panesOf(layout).flatMap((pane) => [...pane.entries.values()].map((entry) => {
    const resource = pane._resources.get(entry.tabId) as {
      title?: string;
      session?: { title?: string; currentUrl?: string };
      store?: { data?: { title?: string } };
      terminal?: { data: { name?: string } };
    } | undefined;
    const state = entry.state as { path?: string; filePath?: string; title?: string };
    const path = state.path ?? state.filePath;
    const title = resource?.title || resource?.session?.title || resource?.session?.currentUrl
      || resource?.store?.data?.title || resource?.terminal?.data.name
      || state.title || (path ? fileBaseName(path) : undefined) || entry.kind;
    return { tab_id: entry.tabId, title, kind: entry.kind, closable: !isConversation(entry.kind) };
  }));
}

export async function closeSessionPaneTab(layout: Layout, tabId: string) {
  const pane = panesOf(layout).find((candidate) => candidate.entries.has(tabId));
  if (!pane) throw new Error('No open tab with this id in this task; use session_list_tabs.');
  const entry = pane.entries.get(tabId)!;
  if (isConversation(entry.kind)) throw new Error('The conversation tab cannot be closed with session_close_tab.');
  await pane.requestCloseTabs([tabId]);
  return { closed: !pane.entries.has(tabId), tabs: sessionPaneTabs(layout) };
}
