import { observer } from 'mobx-react-lite';
import { createContext, useCallback, useContext, useSyncExternalStore, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Folder, MessageSquare, Paperclip, Users } from '@/lib/icons';
import { chatTabSlotKey, readShellSlots } from '@/lib/shellSlots';
import { readChatSummary, subscribeChatSummaries } from '@/lib/chatSummariesBridge';
import { chatFolderNameKeyOf } from '@/components/chat/chatFolderName';
import { RailAppIcon } from '@/components/RailAppIcon';
import { extensionSurfaceStore, extensionTabTitle } from '@renderer/features/extensions/extension-surface-store';
import { installedExtensionsStore } from '@renderer/features/extensions/installed-extensions-store';
import { declaredMenuCommands, runExtensionCommand } from '@renderer/features/extensions/extension-commands';
import { ExtensionTabBadge } from '@renderer/features/extensions/extension-tab-badge';
import type { TabHost } from '@renderer/features/tabs/core/tab-host';
import type { ResolvedTab, TabBarItemProps, TabContentProps, TabEntry, TabResource, TabViewContext } from '@renderer/features/tabs/core/tab-provider';
import { createTabProvider } from '@renderer/features/tabs/core/tab-provider-registry';
import { GenericTabDragPreview, GenericTabItem } from '@renderer/features/tabs/tab-bar/generic-tab-item';
import { parseExtensionTabKind } from '@shared/extensions/manifest';
import { groupPageSlot, isFolderItem, panelItemKey, type PanelItem } from './chat-panel-item';
import { takeRestore } from './chat-tab-restores';
import { translateSessionMessage } from '@renderer/localization/locale-store';

/** The chat itself: its messages and composer, first in its strip, never closed. */
export const CHAT_TAB_KIND = 'chat';
/** Something open beside the messages (`PanelItem`): an App's page, a file in the App that opens it, the host's preview. */
export const CHAT_PANEL_TAB_KIND = 'chat-panel';
/** The topic open beside its group (topics.md): one at a time; opening another shows that one in its place. */
export const CHAT_TOPIC_TAB_KIND = 'chat-topic';
/**
 * The chat's info (owner 10-26: one place for what the chat is — its members, announcement, settings): a tab like the
 * folder's, one a chat; `page` is where it was opened at (the members' button: their list), `at` tells two opens apart.
 */
export const CHAT_INFO_TAB_KIND = 'chat-info';

export type ChatTabState = { chatId: string };
export type ChatTopicState = { topicChatId: string; name: string };
export type ChatInfoState = { group: boolean; page?: 'main' | 'members' | 'announcement'; at?: number };

/** A list of rows: as wide as the drawers it replaces (spec session-page「并排」: a page declares its width beside the chat). */
const CHAT_INFO_SIDE_WIDTH = 360;

/** The chat a strip belongs to (its place, `chat-layouts`). */
export const chatIdOfView = (ctx: TabViewContext): string => (ctx.place?.kind === 'chat' ? ctx.place.chatId : '');

/**
 * What the block holding a chat's strip draws for the chat's own tab — its chip (the project's name or the chat's
 * avatar and name, with that block's menu) and its body (the messages the shell draws into the block's slot).
 */
export interface ChatTabHost {
  chip: (props: { tab: ResolvedTab; host: TabHost }) => ReactNode;
  body: ReactNode;
  /** 「单独一块」 for an App's tab, where the strip is in a block of the screen (a window has none). */
  ownBlock?: (tabId: string) => void;
}
export const ChatTabHostContext = createContext<ChatTabHost | null>(null);

/**
 * Nothing to hold: what a tab shows lives in its state, its page in the shell or the App's layer. The resource only lets
 * the strip read that state (the engine hands tab chips resolved tabs, not entries).
 */
export class ChatTabResource<S> implements TabResource {
  constructor(private readonly entry: TabEntry<S>) {}
  get state(): S {
    return this.entry.state;
  }
  dispose(): void {}
}
const stateResource = <S,>(entry: TabEntry<S>) => new ChatTabResource(entry);
const stateOf = <S,>(tab: ResolvedTab): S => (tab.resource as ChatTabResource<S>).state;

const ChatTabItem = observer(function ChatTabItem({ tab, host }: TabBarItemProps<TabResource>) {
  return <>{useContext(ChatTabHostContext)?.chip({ tab, host }) ?? null}</>;
});

const ChatTabContent = observer(function ChatTabContent(_props: TabContentProps) {
  return <div className="flex h-full w-full min-h-0 min-w-0 flex-col">{useContext(ChatTabHostContext)?.body ?? null}</div>;
});

export const chatTabProvider = createTabProvider<typeof CHAT_TAB_KIND, ChatTabState, TabResource>({
  kind: CHAT_TAB_KIND,
  mount: 'single',
  resourceKey: () => 'chat',
  initialize: stateResource,
  // The chat is the strip's first tab, as a task's conversation is its own: ⌘W, 「关闭全部」 leave it.
  onBeforeClose: () => false,
  dispose: () => {},
  TabBarItem: ChatTabItem,
  TabBarItemDragPreview: () => null,
  TabContent: ChatTabContent,
});

/** What people call this chat's folder, read where the shell's chat list is not (chatFolderNameKey). */
function useFolderName(chatId: string): string {
  const { t } = useTranslation('messaging');
  // Re-read when the summaries change (a chat renamed into a group's topic is still that group's).
  useSyncExternalStore(subscribeChatSummaries, () => readChatSummary(chatId));
  return t(chatFolderNameKeyOf(chatId, (id) => {
    const summary = readChatSummary(id);
    return summary ? { kind: summary.kind, source_chat_id: summary.sourceChatId } : null;
  }));
}

/** A panel tab's name as its strip says it: what its page called itself, else the App's tab title or the file's name. */
function usePanelPresentation(chatId: string, tabId: string, item: PanelItem) {
  const folderName = useFolderName(chatId);
  return extensionTabTitle(
    extensionSurfaceStore.said(null, groupPageSlot(chatId, tabId)),
    isFolderItem(item) ? folderName : item.kind ? (installedExtensionsStore.tabTitle(item.kind) ?? item.title) : item.title,
    item.itemId ? { name: item.title, path: item.fileName ?? item.title } : undefined,
  );
}

const PanelIcon = observer(function PanelIcon({ item }: { item: PanelItem }) {
  if (isFolderItem(item)) return <Folder size={14} />;
  const extensionId = item.kind ? parseExtensionTabKind(item.kind)?.extensionId : undefined;
  const app = extensionId ? installedExtensionsStore.openableApps.find((candidate) => candidate.extensionId === extensionId) : undefined;
  return app ? <RailAppIcon app={app} className="size-4" /> : <Paperclip size={14} />;
});

const PanelTabItem = observer(function PanelTabItem({ tab, host, ctx }: TabBarItemProps<TabResource>) {
  const item = stateOf<PanelItem>(tab);
  const chatId = chatIdOfView(ctx);
  const { label, hint, tooltip } = usePanelPresentation(chatId, tab.tabId, item);
  const surface = extensionSurfaceStore.said(null, groupPageSlot(chatId, tab.tabId));
  const ownBlock = useContext(ChatTabHostContext)?.ownBlock;
  // 「单独一块」(spec session-page「一屏几块」,同任务里 App 那一枚):这张页自己占一块,贴在这一块右边;这个对话里就不留它了。
  // App 声明的菜单命令跟在后面,同任务里的 App 页签(工具栏那一行去掉了,owner 10-26 选 A)。
  const kindCommands = item.kind
    ? [
        ...(ownBlock ? [{ id: `${tab.tabId}:own-block`, label: translateSessionMessage('extensions.ownBlock'), group: 'extension', run: () => ownBlock(tab.tabId) }] : []),
        ...declaredMenuCommands(item.kind).map((command) => ({
          id: `${tab.tabId}:${command.id}`, label: command.title, group: 'extension', run: () => runExtensionCommand(null, groupPageSlot(chatId, tab.tabId), command.id),
        })),
      ]
    : [];
  return (
    <div className="contents" data-panel-tab={isFolderItem(item) ? 'folder' : (item.kind ?? 'preview')}>
      <GenericTabItem tab={tab} host={host} ctx={ctx} label={label} hint={hint} tooltip={tooltip} hasError={surface.error !== null} preSlot={<PanelIcon item={item} />} statusSlot={<ExtensionTabBadge badge={surface.badge} />} kindCommands={kindCommands} />
    </div>
  );
});

const PanelTabDragPreview = observer(function PanelTabDragPreview({ tab }: { tab: ResolvedTab }) {
  const item = stateOf<PanelItem>(tab);
  return <GenericTabDragPreview preSlot={<PanelIcon item={item} />} label={item.title} />;
});

/**
 * One slot per tab of this kind on screen (either half of a pair): the shell draws what the tab shows into it
 * (components/chat/ChatTabPortals.tsx), in its own tree and contexts — the chat's state, the App's offer and update bar,
 * the topic's line. A tab not on screen has no slot, so nothing of it is drawn (an App's own page stays in its layer).
 */
const ShellTabSlots = observer(function ShellTabSlots({ host, ctx, kind }: TabContentProps & { kind: string }) {
  const chatId = chatIdOfView(ctx);
  const shown = host.resolvedTabs.filter((tab) => tab.kind === kind && tab.isActive);
  return (
    <>
      {shown.map((tab) => (
        <ShellTabSlot key={tab.tabId} chatId={chatId} tabId={tab.tabId} />
      ))}
    </>
  );
});

function ShellTabSlot({ chatId, tabId }: { chatId: string; tabId: string }) {
  const ref = useCallback((element: HTMLDivElement | null) => readShellSlots()?.setSlot(chatTabSlotKey(chatId, tabId), element), [chatId, tabId]);
  return <div ref={ref} className="absolute inset-0 flex min-h-0 min-w-0 flex-col" data-chat-tab-slot={tabId} />;
}

function PanelTabContent(props: TabContentProps) {
  return <ShellTabSlots {...props} kind={CHAT_PANEL_TAB_KIND} />;
}

export const chatPanelTabProvider = createTabProvider<typeof CHAT_PANEL_TAB_KIND, PanelItem, TabResource>({
  kind: CHAT_PANEL_TAB_KIND,
  mount: 'single',
  resourceKey: panelItemKey,
  // An App's own page beside the chat is as wide as its manifest says (`sideWidth`); a file, in it or the host's preview, is
  // the chat's peer: half each.
  sideWidth: (item) => (item.kind && !item.itemId ? installedExtensionsStore.sideWidth(item.kind) : undefined),
  // The host's preview holds a message and a file version of this moment: gone with the window, as before.
  isPersistent: (item) => item.kind !== null,
  initialize: stateResource,
  // Closing hands back what it was opened from (a link's message, a topic's attachment: the topic again) — once the tab is
  // gone (the engine removes it after this answer), as closeChatTab does.
  onBeforeClose: (entry, _resource, ctx) => {
    const restore = takeRestore(chatIdOfView(ctx), entry.state);
    if (restore) setTimeout(restore, 0);
    return true;
  },
  dispose: (entry, _resource, ctx) => extensionSurfaceStore.forget(null, groupPageSlot(chatIdOfView(ctx), entry.tabId)),
  TabBarItem: PanelTabItem,
  TabBarItemDragPreview: PanelTabDragPreview,
  TabContent: PanelTabContent,
});

const TopicTabItem = observer(function TopicTabItem({ tab, host, ctx }: TabBarItemProps<TabResource>) {
  const topic = stateOf<ChatTopicState>(tab);
  return (
    <div className="contents" data-topic-tab={topic.topicChatId}>
      <GenericTabItem tab={tab} host={host} ctx={ctx} label={topic.name} preSlot={<MessageSquare size={14} />} />
    </div>
  );
});

function TopicTabContent(props: TabContentProps) {
  return <ShellTabSlots {...props} kind={CHAT_TOPIC_TAB_KIND} />;
}

export const chatTopicTabProvider = createTabProvider<typeof CHAT_TOPIC_TAB_KIND, ChatTopicState, TabResource>({
  kind: CHAT_TOPIC_TAB_KIND,
  mount: 'single',
  resourceKey: () => 'topic',
  // As before: the topic beside a group is this window's; a restart opens the group alone.
  isPersistent: () => false,
  initialize: stateResource,
  dispose: () => {},
  TabBarItem: TopicTabItem,
  TabBarItemDragPreview: ({ tab }) => <GenericTabDragPreview preSlot={<MessageSquare size={14} />} label={stateOf<ChatTopicState>(tab).name} />,
  TabContent: TopicTabContent,
});

const useInfoLabel = (tab: ResolvedTab) => useTranslation('messaging').t(stateOf<ChatInfoState>(tab).group ? 'header.groupInfo' : 'header.chatInfo');

const InfoTabItem = observer(function InfoTabItem({ tab, host, ctx }: TabBarItemProps<TabResource>) {
  return (
    <div className="contents" data-info-tab="">
      <GenericTabItem tab={tab} host={host} ctx={ctx} label={useInfoLabel(tab)} preSlot={<Users size={14} />} />
    </div>
  );
});

const InfoTabDragPreview = observer(function InfoTabDragPreview({ tab }: { tab: ResolvedTab }) {
  return <GenericTabDragPreview preSlot={<Users size={14} />} label={useInfoLabel(tab)} />;
});

function InfoTabContent(props: TabContentProps) {
  return <ShellTabSlots {...props} kind={CHAT_INFO_TAB_KIND} />;
}

export const chatInfoTabProvider = createTabProvider<typeof CHAT_INFO_TAB_KIND, ChatInfoState, TabResource>({
  kind: CHAT_INFO_TAB_KIND,
  mount: 'single',
  resourceKey: () => 'info',
  sideWidth: () => CHAT_INFO_SIDE_WIDTH,
  initialize: stateResource,
  dispose: () => {},
  TabBarItem: InfoTabItem,
  TabBarItemDragPreview: InfoTabDragPreview,
  TabContent: InfoTabContent,
});
