import type { MessageItem } from '@gugu/core/shared/types/chat';
import type { ChatPeekFile } from '@shared/extensions/app-runtime-protocol';
import { parseExtensionTabKind } from '@shared/extensions/manifest';

/** The preinstalled workspace App's tab (apps/desktop/preinstalled-apps/workspace, `WORKSPACE_APP_ID`): with no file, the chat's folder. */
export const WORKSPACE_APP_KIND = 'workspace.main';

/**
 * One thing a chat has open beside its messages, as one tab of the chat's strip (owner 10-24: one App's one resource
 * is one tab): an App's own page in this chat — the chat's folder is one, the workspace App's — or a file of the chat,
 * in the App that opens it; no App claims it (`kind: null`): the host's preview.
 */
export interface PanelItem {
  /** `<extensionId>.<tab>`; null: no App claims the file, the host's file preview. */
  kind: string | null;
  /** The file it shows; none for an App's own page (the folder is one). */
  itemId?: string;
  title: string;
  /** Original file name for downloads and tooltips; title is its display name. */
  fileName?: string;
  /** What kind of file it is (`typedFileName`): who opens it is decided by this. None without a file. */
  typedName?: string;
  /** The host's preview reads the file through this (kind null only). */
  file?: ChatPeekFile;
  /** The message it was opened from: the preview forwards it. */
  message?: MessageItem;
}

export const folderItem = (): PanelItem => ({ kind: WORKSPACE_APP_KIND, title: '' });
export const isFolderItem = (item: PanelItem | null | undefined): boolean => item?.kind === WORKSPACE_APP_KIND && !item.itemId;

const appOf = (kind: string | null) => (kind === null ? null : (parseExtensionTabKind(kind)?.extensionId ?? kind));

/**
 * A tab's identity (owner 10-24): the same file in the same App, through any of its tabs, is one tab; an App's own page
 * (the folder, a group's member list) is one a chat. The engine dedupes on it (`resourceKey`, `mount: 'single'`).
 */
export const panelItemKey = (item: PanelItem): string =>
  item.itemId ? `file:${appOf(item.kind) ?? ''}:${item.itemId}` : `page:${item.kind ?? ''}`;

/**
 * The slot identity of a tab's page — what the App's context says its tab is, and what its title, badge, error and peek
 * are kept under (`extensionSurfaceStore`, `peekStore`, with no session).
 */
export const groupPageSlot = (chatId: string, tabId: string) => `group-app-slot:${chatId}#${tabId}`;
