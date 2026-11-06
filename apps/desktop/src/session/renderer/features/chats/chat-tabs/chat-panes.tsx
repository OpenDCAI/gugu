import { OwnedAgentChatBoundary } from '../owned-agent-chat-boundary';
import { DndContext } from '@dnd-kit/core';
import { observer } from 'mobx-react-lite';
import { useEffect, useMemo, type ReactNode, type ComponentProps } from 'react';
import { screenLayout } from '@renderer/app/screen-layout';
import { openChatTabInWindow, placeOnScreen, revealTabWindow } from '@renderer/app/screen-layout-actions';
import { ChatPartSlot } from '@renderer/lib/chat-slot';
import { edgeFirst, PANE_EDGES, PaneEdgeDropZones } from '@renderer/features/tabs/pane-edge-drop';
import { useTabDrag } from '@renderer/features/tabs/use-tab-drag';
import { PaneContent } from '@renderer/features/tabs/pane-content';
import { PaneProvider } from '@renderer/features/tabs/pane-context';
import { TabDragOverlay } from '@renderer/features/tabs/tab-bar/tab-drag-preview';
import { PaneLayoutProvider } from '@renderer/features/tabs/pane-layout-context';
import { SplitPaneHotkey } from '@renderer/features/sessions/tab-bar-actions';
import type { TabHost } from '@renderer/features/tabs/core/tab-host';
import type { ResolvedTab } from '@renderer/features/tabs/core/tab-provider';
import { PaneTreeView } from '@renderer/features/tabs/pane-tree-view';
import { TabChip, TabSlot } from '@renderer/features/tabs/tab-bar/tab-chip';
import { ContextMenu } from '@/components/ui/Menu';
import { chatAuxiliaryYielded, chatBlockContentOf, chatLayoutOf, closeChatTab } from './chat-layouts';
import { CHAT_TAB_KIND, ChatTabHostContext, type ChatTabHost } from './chat-tab-providers';

/**
 * A chat's block (gugu-dev#181: a project's group, a chat ⌘-clicked beside a task): one strip on the task's engine —
 * the chat first, then what is open beside it (the folder, Apps, files, the topic) — and below it the chat with what
 * pairs with it, left or right, above or below (spec session-page「并排」): drag a tab to an edge, its menu's 「向右分 /
 * 向下分」, ⌘\; 「拆开」 and either fills the block. The shell draws each tab's content into the slot left for it.
 */
const LegacyChatPanes = observer(function LegacyChatPanes({
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
    layout.setWindowOpener((tabId) => (layout.groups.find(({ pane }) => pane.entries.has(tabId))?.pane.entries.get(tabId)?.kind === CHAT_TAB_KIND ? null : () => openChatTabInWindow(chatId, layout, tabId)));
    layout.setWindowRevealer(revealTabWindow);
    return () => {
      layout.setWindowOpener(null);
      layout.setWindowRevealer(null);
    };
  }, [layout, chatId]);
  const drag = useTabDrag({
    layout,
    blockId,
    // An App page of this chat is a block of its own on another block's edge, and leaves the chat's strip.
    contentOf: (tabId) => chatBlockContentOf(chatId, tabId),
    landed: (tabId) => closeChatTab(chatId, tabId),
    // Out of the window, any but the chat's own tab opens in a window of its own.
    openWindow: (tabId) => (layout.groups.find(({ pane }) => pane.entries.has(tabId))?.pane.entries.get(tabId)?.kind === CHAT_TAB_KIND ? null : (at) => openChatTabInWindow(chatId, layout, tabId, at)),
  });
  const dragging = drag.dragging;
  return (
    <ChatTabHostContext.Provider value={host}>
      <PaneLayoutProvider paneLayout={layout}>
        <DndContext sensors={drag.sensors} collisionDetection={edgeFirst} onDragStart={drag.onDragStart} onDragMove={drag.onDragMove} onDragEnd={drag.onDragEnd} onDragCancel={drag.onDragCancel}>
          <PaneTreeView layout={layout} singlePaneId={chatAuxiliaryYielded(chatId) ? layout.groups.find(({ pane }) => [...pane.entries.values()].some((entry) => entry.kind === CHAT_TAB_KIND))?.paneId : undefined} renderPane={(paneId, first, last, part) => {
            const group = layout.groups.find((candidate) => candidate.paneId === paneId)!;
            const focused = screenLayout.focusedBlockId === blockId && layout.activePaneId === paneId;
            const strip = { tabTrailingSlot: <ChatPartSlot chatId={chatId} part="tabs" className="flex h-full items-center" />, actionsSlot: last ? actionsSlot : undefined, reserveShellRestoreLane: first && reserveShellRestoreLane };
            if (part === 'bar') return <PaneProvider group={group} isFocusedPane={focused} passive><PaneContent part="bar" {...strip} /></PaneProvider>;
            const edges = dragging === null ? [] : PANE_EDGES.filter((edge) => layout.splitBlocked(paneId, dragging, edge) === null);
            return <PaneProvider group={group} isFocusedPane={focused}>
              <SplitPaneHotkey />
              <div className="h-full min-h-0 min-w-0" data-pane-cell={paneId} data-chat-panes={chatId} onPointerDown={() => layout.setActiveGroup(paneId)}>
                <PaneContent part={part} {...strip} contentOverlay={edges.length ? <PaneEdgeDropZones paneId={paneId} edges={edges} /> : null} />
              </div>
            </PaneProvider>;
          }} />
          <TabDragOverlay />
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
  /** The block's available chat or project actions; absent when there are none. */
  menu: ReactNode;
  [data: `data-${string}`]: string | undefined;
}) {
  const chip = <TabChip
    isActive={tab.isActive} isFocusedPane={focused && (tab.isFocused ?? true)} pairRole={tab.pairRole}
    label={label} labelSlot={labelSlot} onClick={() => host.setActiveTab(tab.tabId)}
  />;
  return (
    <TabSlot data-tabid={tab.tabId} data-tab-pair={tab.pairRole} {...data}>
      {menu ? <ContextMenu.Root>
        <ContextMenu.Trigger className="flex h-full w-full min-w-0">{chip}</ContextMenu.Trigger>
        <ContextMenu.Content finalFocus={false} className="min-w-40">{menu}</ContextMenu.Content>
      </ContextMenu.Root> : chip}
    </TabSlot>
  );
});

/** No legacy pane or resource slots are created for an owned-agent conversation. */
export function ChatPanes(props: ComponentProps<typeof LegacyChatPanes>) {
  return <OwnedAgentChatBoundary chatId={props.chatId}><LegacyChatPanes {...props} /></OwnedAgentChatBoundary>;
}
