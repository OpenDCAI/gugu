import { DndContext, DragOverlay } from '@dnd-kit/core';
import { observer } from 'mobx-react-lite';
import { useEffect, useMemo, type ReactNode } from 'react';
import { screenLayout } from '@renderer/app/screen-layout';
import { openChatTabInWindow, placeOnScreen, revealTabWindow } from '@renderer/app/screen-layout-actions';
import { ChatPartSlot } from '@renderer/lib/chat-slot';
import { edgeFirst, PANE_EDGES, PaneEdgeDropZones } from '@renderer/features/tabs/pane-edge-drop';
import { useTabDrag } from '@renderer/features/tabs/use-tab-drag';
import { PaneContent } from '@renderer/features/tabs/pane-content';
import { PaneProvider } from '@renderer/features/tabs/pane-context';
import { TabDragPreview } from '@renderer/features/tabs/tab-bar/tab-drag-preview';
import { PaneLayoutProvider } from '@renderer/features/tabs/pane-layout-context';
import { SplitPaneHotkey } from '@renderer/features/sessions/tab-bar-actions';
import type { TabHost } from '@renderer/features/tabs/core/tab-host';
import type { ResolvedTab } from '@renderer/features/tabs/core/tab-provider';
import { PairSeparator } from '@renderer/features/tabs/tab-bar/pair-separator';
import { TabChip, TabSlot } from '@renderer/features/tabs/tab-bar/tab-chip';
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@renderer/lib/ui/context-menu';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { chatBlockContentOf, chatLayoutOf, closeChatTab } from './chat-layouts';
import { CHAT_TAB_KIND, ChatTabHostContext, type ChatTabHost } from './chat-tab-providers';

/**
 * A chat's block (gugu-dev#181: a project's group, a chat ⌘-clicked beside a task): one strip on the task's engine —
 * the chat first, then what is open beside it (the folder, Apps, files, the topic) — and below it the chat with what
 * pairs with it, left or right, above or below (spec session-page「并排」): drag a tab to an edge, its menu's 「向右分 /
 * 向下分」, ⌘\; 「拆开」 and either fills the block. The shell draws each tab's content into the slot left for it.
 */
export const ChatPanes = observer(function ChatPanes({
  chatId,
  blockId,
  chip,
  body,
  actionsSlot,
  reserveShellRestoreLane,
}: Pick<ChatTabHost, 'chip' | 'body'> & {
  chatId: string;
  blockId: string;
  /** The strip's far end: the chat's icons (search, folder, members), the block's own close. */
  actionsSlot: ReactNode;
  reserveShellRestoreLane?: boolean;
}) {
  const layout = chatLayoutOf(chatId);
  const group = layout.groups[0]!;
  const host = useMemo<ChatTabHost>(() => ({
    chip,
    body,
    ownBlock: (tabId) => {
      const content = chatBlockContentOf(chatId, tabId);
      if (content && placeOnScreen(content, blockId, 'right')) closeChatTab(chatId, tabId);
    },
  }), [chip, body, chatId, blockId]);
  // 页签右键「在新窗口打开」:除了这个对话自己那一枚,哪一枚都能单独成窗(和任务里的附页一样);它在窗里 = 把窗提到前面。
  useEffect(() => {
    layout.setWindowOpener((tabId) => (group.pane.entries.get(tabId)?.kind === CHAT_TAB_KIND ? null : () => openChatTabInWindow(chatId, layout, tabId)));
    layout.setWindowRevealer(revealTabWindow);
    return () => {
      layout.setWindowOpener(null);
      layout.setWindowRevealer(null);
    };
  }, [layout, group, chatId]);
  const drag = useTabDrag({
    layout,
    blockId,
    // An App page of this chat is a block of its own on another block's edge, and leaves the chat's strip.
    contentOf: (tabId) => chatBlockContentOf(chatId, tabId),
    landed: (tabId) => closeChatTab(chatId, tabId),
    // Out of the window, any but the chat's own tab opens in a window of its own.
    openWindow: (tabId) => (group.pane.entries.get(tabId)?.kind === CHAT_TAB_KIND ? null : (at) => openChatTabInWindow(chatId, layout, tabId, at)),
  });
  const dragging = drag.dragging;
  // Dragged to an edge = beside the chat that way (or the other way round); no edge where two pages do not fit.
  const edges = dragging === null ? [] : PANE_EDGES.filter((edge) => group.pane.pairSplitBlocked(dragging, edge) === null);
  return (
    <ChatTabHostContext.Provider value={host}>
      <PaneLayoutProvider paneLayout={layout}>
        <DndContext sensors={drag.sensors} collisionDetection={edgeFirst} onDragStart={drag.onDragStart} onDragMove={drag.onDragMove} onDragEnd={drag.onDragEnd} onDragCancel={drag.onDragCancel}>
          <PaneProvider group={group} isFocusedPane={screenLayout.focusedBlockId === blockId}>
            <SplitPaneHotkey />
            <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-pane-cell={group.paneId} data-chat-panes={chatId}>
              <PaneContent
                // 「+」 after the last tab: the folder and the Apps that open here, drawn by the shell (it knows them).
                tabTrailingSlot={<ChatPartSlot chatId={chatId} part="tabs" className="flex h-full items-center" />}
                actionsSlot={actionsSlot}
                reserveShellRestoreLane={reserveShellRestoreLane}
                contentOverlay={edges.length > 0 ? <PaneEdgeDropZones paneId={group.paneId} edges={edges} /> : null}
              />
            </div>
          </PaneProvider>
          <DragOverlay dropAnimation={null}>{dragging ? <TabDragPreview tabId={dragging} /> : null}</DragOverlay>
        </DndContext>
      </PaneLayoutProvider>
    </ChatTabHostContext.Provider>
  );
});

/**
 * The chat's own tab: the chat (or its project) by name, never closed, not dragged — the strip's first, as a task's
 * conversation. Paired, it joins the other tab as one (its 「拆开」 on the line between them when it is the right one).
 */
export const ChatTabChip = observer(function ChatTabChip({
  tab,
  host,
  focused,
  label,
  labelSlot,
  menu,
  ...data
}: {
  tab: ResolvedTab;
  host: TabHost;
  focused: boolean;
  label: string;
  labelSlot?: ReactNode;
  /** This block's menu for its chat (announcement, settings, Apps in this chat). */
  menu: ReactNode;
  [data: `data-${string}`]: string | undefined;
}) {
  const { translate } = useSessionMessages();
  return (
    <TabSlot data-tabid={tab.tabId} data-tab-pair={tab.pairRole} {...data}>
      {tab.pairRole === 'end' ? <PairSeparator label={translate('tabs.separatePair')} onSeparate={() => host.separatePair()} /> : null}
      <ContextMenu>
        <ContextMenuTrigger className="flex h-full w-full min-w-0">
          <TabChip
            isActive={tab.isActive}
            isFocusedPane={focused && (tab.isFocused ?? true)}
            pairRole={tab.pairRole}
            label={label}
            labelSlot={labelSlot}
            onClick={() => host.setActiveTab(tab.tabId)}
          />
        </ContextMenuTrigger>
        <ContextMenuContent finalFocus={false} className="min-w-40">
          {menu}
        </ContextMenuContent>
      </ContextMenu>
    </TabSlot>
  );
});
