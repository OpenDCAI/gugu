import { action, reaction, runInAction } from 'mobx';
import type { MessageItem } from '@gugu/core/shared/types/chat';
import type { AppOpenWithDetail } from '@shared/extensions/app-runtime-protocol';
import { displayNameOf, fileOpenersFor } from '@shared/extensions/file-openers';
import type { ExtensionManifest } from '@shared/extensions/manifest';
import { typedFileName } from '@shared/extensions/app-runtime-protocol';
import type { ScreenBlockContent } from '@renderer/app/screen-layout';
import type { PaneLayoutStore } from '@renderer/features/tabs/pane-layout-store';
import type { PaneStore } from '@renderer/features/tabs/pane-store';
import { createTabView } from '@renderer/features/tabs/tab-view-factory';
import { TabViewPersistor } from '@renderer/features/tabs/tab-view-persistor';
import { viewStateCache } from '@renderer/lib/stores/view-state-cache';
import { readChatSummary } from '@/lib/chatSummariesBridge';
import { panelItemKey, type PanelItem } from './chat-panel-item';
import { keepRestore, takeRestore } from './chat-tab-restores';
import {
  CHAT_INFO_TAB_KIND,
  CHAT_PANEL_TAB_KIND,
  CHAT_TAB_KIND,
  CHAT_TOPIC_TAB_KIND,
  chatInfoTabProvider,
  chatPanelTabProvider,
  chatTabProvider,
  chatTopicTabProvider,
  type ChatInfoState,
  type ChatTopicState,
} from './chat-tab-providers';

/**
 * A chat's strip, on the same engine as a task's (spec session-page「并排」): the chat is its first tab, as a task's
 * conversation is; what opens beside it pairs with it, left or right, above or below; separated, either fills the block.
 */
export const chatTabView = createTabView([chatTabProvider, chatPanelTabProvider, chatTopicTabProvider, chatInfoTabProvider] as const, {
  // Kept as a task's tabs are (`chat:<id>:tabs` in view-state).
  makePersistor: (ctx) => new TabViewPersistor(ctx.viewId),
});

export type ChatLayout = PaneLayoutStore<typeof chatTabView.registry>;

const layouts = new Map<string, ChatLayout>();

/** The chat's tab: the strip's first, put back first if anything lands before it (a drop, a restored save). */
function keepChatFirst(layout: ChatLayout): void {
  const pane = layout.groups[0]!.pane;
  const chatTab = pane.tabOrder.find((id) => pane.entries.get(id)?.kind === CHAT_TAB_KIND);
  const at = chatTab ? pane.tabOrder.indexOf(chatTab) : -1;
  if (at > 0) pane.reorderTabs(at, 0);
}

/**
 * The chat's strip, made the first time anything asks for it (a block draws it, the shell opens something in it) and
 * kept for the window, as before (摩擦单 F29) — and across restarts where the session page has its saved state.
 */
export function chatLayoutOf(chatId: string): ChatLayout {
  const existing = layouts.get(chatId);
  if (existing) return existing;
  const layout = chatTabView.createPaneLayoutStore({ viewId: `chat:${chatId}`, place: { kind: 'chat', chatId } }, { singleStrip: true }) as ChatLayout;
  layouts.set(chatId, layout);
  runInAction(() => {
    // Saved state is only in the cache the session page loaded at boot; read before that (the phone has none), the
    // strip starts empty and is not saved — saving it would write an empty strip over the one kept.
    const persisted = viewStateCache.populated;
    if (persisted) layout.hydrate();
    if (!chatTabOf(layout)) layout.open(CHAT_TAB_KIND, { chatId });
    keepChatFirst(layout);
    layout.setViewActive(true);
    if (persisted) layout.startPersistence();
  });
  layout.setPairAnchor(() => {
    const pane = layout.groups[0]!;
    const tabId = chatTabOf(layout);
    return tabId ? { paneId: pane.paneId, tabId } : null;
  });
  reaction(() => layout.groups[0]!.pane.tabOrder, () => keepChatFirst(layout));
  return layout;
}

const paneOf = (layout: ChatLayout): PaneStore => layout.groups[0]!.pane;
function chatTabOf(layout: ChatLayout): string | undefined {
  const pane = paneOf(layout);
  return pane.tabOrder.find((id) => pane.entries.get(id)?.kind === CHAT_TAB_KIND);
}

export interface ChatPanelTab {
  tabId: string;
  item: PanelItem;
  /** On screen (either half of a pair, or the whole block). */
  shown: boolean;
  /** The one holding focus. */
  focused: boolean;
  /** In a window of its own (its page there is its own, not the main window's layer). */
  inWindow: boolean;
}

/** Every tab of the chat with the pane it is in: its strip's, in strip order, then each one in a window of its own. */
function tabsOf(layout: ChatLayout) {
  const panes = [paneOf(layout), ...[...layout.windowPanes.values()].map((windowPane) => windowPane.pane)];
  return panes.flatMap((pane) => pane.resolvedTabs.map((tab) => ({ tab, pane, inWindow: pane !== paneOf(layout) })));
}

/** The chat's panel tabs, in strip order (one in a window of its own is shown there, and listed last). */
export function panelTabsOf(chatId: string): ChatPanelTab[] {
  return tabsOf(chatLayoutOf(chatId))
    .filter(({ tab }) => tab.kind === CHAT_PANEL_TAB_KIND)
    .map(({ tab, pane, inWindow }) => ({ tabId: tab.tabId, item: pane.entries.get(tab.tabId)!.state as PanelItem, shown: tab.isActive, focused: tab.isFocused ?? tab.isActive, inWindow }));
}

export const panelTabOf = (chatId: string, tabId: string): ChatPanelTab | null => panelTabsOf(chatId).find((tab) => tab.tabId === tabId) ?? null;

/** The chat's strip and where a tab of it is: its strip, or the window it is in. */
function paneHolding(layout: ChatLayout, tabId: string): PaneStore | null {
  return tabsOf(layout).find(({ tab }) => tab.tabId === tabId)?.pane ?? null;
}

/** The panel tab shown on screen that holds focus, else the first one shown; null: only the chat (or a topic) is up. */
export function shownPanelTab(chatId: string): ChatPanelTab | null {
  const shown = panelTabsOf(chatId).filter((tab) => tab.shown);
  return shown.find((tab) => tab.focused) ?? shown[0] ?? null;
}

/** Whether only the chat is on screen: nothing beside it. */
export function chatAlone(chatId: string): boolean {
  const layout = chatLayoutOf(chatId);
  const pane = paneOf(layout);
  return pane.shownTabIds.length === 1 && pane.shownTabIds[0] === chatTabOf(layout);
}

/** The tab holding focus — on the phone and in a window without a strip, the one page shown. */
export function focusedChatTab(chatId: string): { tabId: string; kind: 'chat' | 'panel' | 'topic' | 'info' } | null {
  const pane = paneOf(chatLayoutOf(chatId));
  const tabId = pane.resolvedActiveTabId;
  const kind = tabId ? pane.entries.get(tabId)?.kind : undefined;
  if (!tabId || !kind) return null;
  return { tabId, kind: kind === CHAT_PANEL_TAB_KIND ? 'panel' : kind === CHAT_TOPIC_TAB_KIND ? 'topic' : kind === CHAT_INFO_TAB_KIND ? 'info' : 'chat' };
}

/** The tab a closed tab goes back to (its 上一页), while that is still open. */
export function returnToOf(chatId: string, tabId: string): string | null {
  const pane = paneHolding(chatLayoutOf(chatId), tabId);
  const back = pane?.returnToOf(tabId)?.tabId;
  return back && pane?.entries.has(back) ? back : null;
}

/**
 * Show this beside the chat (spec session-page「并排」, as an agent's file beside its conversation): open already, it
 * is that tab, its page as it is (owner 10-24); else a new tab after the others. `returnTo`: the tab whose page opened
 * it (a file clicked in the folder, an App's `files.openWith`), what closing it goes back to. `restore`: what closing
 * it hands back to whoever opened it (a link's message). Returns its tab.
 */
export const openPanelItem = action(function openPanelItem(
  chatId: string,
  item: PanelItem,
  opts?: { returnTo?: string; restore?: () => void },
): string | undefined {
  const layout = chatLayoutOf(chatId);
  if (opts?.restore) keepRestore(chatId, item, opts.restore);
  layout.open(CHAT_PANEL_TAB_KIND, item, { beside: true, overrideState: true, ...(opts?.returnTo ? { returnTo: { tabId: opts.returnTo } } : {}) });
  const pane = paneOf(layout);
  return pane.findSingleMountEntry(CHAT_PANEL_TAB_KIND, panelItemKey(item))?.tabId;
});

/** An App installed while its kind of file is open takes the file over in place: the same tab, now in that App. */
export const replacePanelItem = action(function replacePanelItem(chatId: string, tabId: string, item: PanelItem): void {
  paneHolding(chatLayoutOf(chatId), tabId)?.retargetEntry(tabId, { state: item });
});

/**
 * What an App tab of this chat is as a block of its own (dragged to a block's edge, its menu's 「单独一块」): that chat's
 * page of the App, or the page made for its file; the host's preview and the chat's own tab stay in the chat.
 */
export function chatBlockContentOf(chatId: string, tabId: string): Extract<ScreenBlockContent, { kind: 'chat-app' }> | null {
  const tab = panelTabOf(chatId, tabId);
  if (!tab?.item.kind) return null;
  return { kind: 'chat-app', chatId, tabKind: tab.item.kind, title: tab.item.title, ...(tab.item.itemId ? { itemId: tab.item.itemId } : {}) };
}

/** Leave a tab (its ×, the page's 「返回」, its App quit): to its 上一页 if open, else the engine's neighbour; the chat stays. */
export const closeChatTab = action(function closeChatTab(chatId: string, tabId: string): void {
  const pane = paneHolding(chatLayoutOf(chatId), tabId);
  const entry = pane?.entries.get(tabId);
  if (!pane || !entry || entry.kind === CHAT_TAB_KIND) return;
  // Now, not after a confirm round (none of these asks one); what closing hands back runs once the tab is gone, as its × does.
  const restore = entry.kind === CHAT_PANEL_TAB_KIND ? takeRestore(chatId, entry.state as PanelItem) : undefined;
  pane.closeTab(tabId);
  restore?.();
});

/** A tab clicked or asked for: it is the one shown (beside the chat when the two are a pair). */
export const showChatTab = action(function showChatTab(chatId: string, tabId: string): void {
  paneOf(chatLayoutOf(chatId)).setActiveTab(tabId);
});

/** Show only the chat (its tab clicked from the shell: a message to reveal, the phone's way back). */
export const showChatOnly = action(function showChatOnly(chatId: string): void {
  const layout = chatLayoutOf(chatId);
  const chatTab = chatTabOf(layout);
  if (chatTab) paneOf(layout).setActiveTab(chatTab);
});

/**
 * The panel tab fills the block (its 「展开」, a session peeked beside its page) — the two separated, as the divider's
 * 「拆开」; or back beside the chat (「还原」): the pair again, the strip's split decline lifted as a split does.
 */
export const setPanelFull = action(function setPanelFull(chatId: string, tabId: string, full: boolean): void {
  const layout = chatLayoutOf(chatId);
  const pane = paneOf(layout);
  const chatTab = chatTabOf(layout);
  if (!pane.entries.has(tabId) || !chatTab) return;
  if (full) {
    // 程序为让位拆开(会话浮在页上),不是用户对这一类说「不并排」:❌ 记下来(owner 10-28)。
    if (pane.livePair) pane.separatePair({ remember: false });
    pane.setActiveTab(tabId);
    return;
  }
  // 回到对话旁边:这一类若被用户拆开过,这一下就是他又让它并排了(只清这一类)。
  pane.splitDeclinedKinds.delete(pane.entries.get(tabId)?.kind ?? '');
  pane.pairWith(chatTab, tabId);
  pane.setActiveTab(tabId);
});

/** Whether this panel tab fills the block (on screen without the chat beside it). */
export function panelFull(chatId: string, tabId: string): boolean {
  const layout = chatLayoutOf(chatId);
  const shown = paneOf(layout).shownTabIds;
  return shown.includes(tabId) && !shown.includes(chatTabOf(layout) ?? '');
}

/** The topic open beside this group, and whether it is on screen. */
export function topicTabOf(chatId: string): { tabId: string; topic: ChatTopicState; shown: boolean } | null {
  const found = tabsOf(chatLayoutOf(chatId)).find(({ tab }) => tab.kind === CHAT_TOPIC_TAB_KIND);
  return found ? { tabId: found.tab.tabId, topic: found.pane.entries.get(found.tab.tabId)!.state as ChatTopicState, shown: found.tab.isActive } : null;
}

/** Open a topic beside its group (topics.md: beside the source line); another topic open takes its place. */
export const openTopicTab = action(function openTopicTab(chatId: string, topic: ChatTopicState): void {
  chatLayoutOf(chatId).open(CHAT_TOPIC_TAB_KIND, topic, { beside: true, overrideState: true });
});

/** The topic leaves its group's tabs (its ×; a topic is never closed by this). */
export const closeTopicTab = action(function closeTopicTab(chatId: string): void {
  const tab = topicTabOf(chatId);
  if (tab) paneHolding(chatLayoutOf(chatId), tab.tabId)?.closeTab(tab.tabId);
});

/**
 * The topic put away (its row in the list clicked again): it leaves the screen, and the strip — a pair keeps both halves
 * on screen, so short of closing it there is no way to have it a tab and not shown. Opened again, it comes back.
 */
export const hideTopicTab = action(function hideTopicTab(chatId: string): void {
  if (topicTabOf(chatId)?.shown) closeTopicTab(chatId);
});

/** The chat's info tab (members, announcement, settings), and whether it is on screen. */
export function infoTabOf(chatId: string): { tabId: string; info: ChatInfoState; shown: boolean } | null {
  const found = tabsOf(chatLayoutOf(chatId)).find(({ tab }) => tab.kind === CHAT_INFO_TAB_KIND);
  return found ? { tabId: found.tab.tabId, info: found.pane.entries.get(found.tab.tabId)!.state as ChatInfoState, shown: found.tab.isActive } : null;
}

/**
 * The chat's info beside it (its members' button, its tab's menu, a command): open already, it comes forward — at `page`
 * when one is asked for, else as it is.
 */
export const openInfoTab = action(function openInfoTab(chatId: string, page?: ChatInfoState['page']): void {
  const open = infoTabOf(chatId);
  const group = readChatSummary(chatId)?.kind === 'group';
  chatLayoutOf(chatId).open(CHAT_INFO_TAB_KIND, page || !open ? { group, page, at: Date.now() } : open.info, { beside: true, overrideState: true });
});

/** The info tab leaves the strip (its members' button pressed again). */
export const closeInfoTab = action(function closeInfoTab(chatId: string): void {
  const tab = infoTabOf(chatId);
  if (tab) paneHolding(chatLayoutOf(chatId), tab.tabId)?.closeTab(tab.tabId);
});

/** Every group file open in a tab, in any chat: the folder's revisions read their names. */
export function openFileIds(): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const layout of layouts.values()) {
    for (const { pane, tab } of tabsOf(layout)) {
      const entry = pane.entries.get(tab.tabId);
      if (entry?.kind !== CHAT_PANEL_TAB_KIND) continue;
      const itemId = (entry.state as PanelItem).itemId;
      if (itemId) ids.add(itemId);
    }
  }
  return ids;
}

/** Fresh file metadata changes a tab's name, not its page, selection or place in the strip. */
export const updateFileNames = action(function updateFileNames(
  files: readonly { id: string; filename: string; content_type: string | null }[],
  installed: readonly ExtensionManifest[],
): void {
  const names = new Map(files.map((file) => [file.id, file]));
  // A topic and its source chat can both have the same shared-folder file open.
  for (const layout of layouts.values()) {
    for (const { pane, tab } of tabsOf(layout)) {
      const entry = pane.entries.get(tab.tabId);
      if (entry?.kind !== CHAT_PANEL_TAB_KIND) continue;
      const item = entry.state as PanelItem;
      const file = item.itemId ? names.get(item.itemId) : undefined;
      if (!file || item.fileName === file.filename) continue;
      const typedName = typedFileName({ name: file.filename, contentType: file.content_type });
      const claim = fileOpenersFor(typedName, installed, 'chat').find((candidate) => candidate.tabKind === item.kind);
      entry.state = { ...item, title: claim ? displayNameOf(file.filename, claim.suffix) : file.filename, fileName: file.filename, typedName };
    }
  }
});

/**
 * What a chat is asked to open — every way in, one channel: an App (`app`: its own page, or the file it names in the
 * chat, `chatFile`), or a file of the chat and the place a pill points at (`opener`: `files.openWith`, whose host
 * already said who opens it, or among which the person picks; `fromPage`: a page beside the chat asked).
 */
export type ChatOpenAsk =
  | { app: string; tab?: string }
  | { itemId: string; at?: Record<string, string>; opener?: AppOpenWithDetail; message?: MessageItem; restore?: () => void; fromPage?: true };

const asks = new Map<string, ChatOpenAsk>();
/**
 * Something asked of a chat (a link, a card, an App, a page's `files.openWith`): the chat answers it when it is on
 * screen — what opens it is found by the shell (its Apps, its prompts), asked while the chat may not be drawn yet.
 */
export function askChat(chatId: string, what: ChatOpenAsk): void {
  asks.set(chatId, what);
}
/** What was asked of this chat, once: taken by the chat that answers it. */
export function takeChatAsk(chatId: string | null | undefined): ChatOpenAsk | null {
  if (!chatId) return null;
  const what = asks.get(chatId) ?? null;
  asks.delete(chatId);
  return what;
}
