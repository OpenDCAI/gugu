import { DndContext } from '@dnd-kit/core';
import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import { useScreenBlock } from '@renderer/app/screen-block-context';
import { auxLeadingReserve, PutBackButton } from '@renderer/app/aux-window-host';
import { BlockGrip, CloseBlockButton, droppedOutsideWindow, startSessionBlockDrag } from '@renderer/app/screen-frame';
import { screenLayout, type WindowableContent } from '@renderer/app/screen-layout';
import {
  closeScreenBlock,
  openInWindow,
  openTabInWindow,
  putBackFromWindow,
  revealTabWindow,
} from '@renderer/app/screen-layout-actions';
import { auxWindows } from '@renderer/app/aux-windows';
import { sessionRegistry } from '@renderer/features/sessions/stores/session-registry';
import { PaneContent } from '@renderer/features/tabs/pane-content';
import { PaneProvider } from '@renderer/features/tabs/pane-context';
import { edgeFirst, PANE_EDGES, PaneEdgeDropZones } from '@renderer/features/tabs/pane-edge-drop';
import { useTabDrag } from '@renderer/features/tabs/use-tab-drag';
import { PaneTreeView } from '@renderer/features/tabs/pane-tree-view';
import { TabDragOverlay } from '@renderer/features/tabs/tab-bar/tab-drag-preview';
import { useWorkspaceLayoutContext } from '@renderer/lib/layout/layout-provider';
import { ContextMenu, MenuItem, MenuSeparator } from '@/components/ui/Menu';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { sessionViewOfRuntime } from '@shared/core/sessions/sessions';
import { parseExtensionTabKind } from '@shared/extensions/manifest';
import { isTaskOwnedTab } from '../../extensions/task-owned-tab';
import { openSessionInSessionWhenReady } from '../open-session-in-session';
import { PaneEmptyState } from '../pane-empty-state';
import { keepBlockFilled } from './keep-block-filled';
import { SplitPaneHotkey, TabBarAddMenu } from '../tab-bar-actions';
import { TabBarActionRow } from '../titlebar-actions';
import { useSessionViewContext, useWorkspaceViewModel } from '../session-view-context';
import { SessionActionsProvider, SessionReadyGate } from './session-actions';
import { activeChatSessionId, CHAT_TAB_KINDS } from './session-pane-policy';
import { TerminalModelMenu } from './terminal-model-menu';
import { useSessionStartupFailure } from '../use-session-startup-failure';

/**
 * 会话页的主区(spec session-page「一屏几块」,#7052):一个会话一块,块里的格子按一棵树摆 —— 左右并排或上下叠着,
 * 可以一层套一层。对话是会话的第一枚页签(写会话名),和审阅、终端、浏览器、文件一样排在页签条上;
 * ❌ 不再有「左聊天列 + 右工作区面板」,也就没有面板的收起 / 全屏。
 *
 * 拖页签:落在另一格的页签条或正中 = 搬过去;落在一格的上下左右边 = 在那边分出一格。拖的过程中画出落点。
 * 附页拖不出这条会话:每个会话页各有自己的拖拽上下文。
 */
export const SessionMainColumn = observer(function SessionMainColumn() {
  const sessionView = useWorkspaceViewModel();
  const { paneLayout } = sessionView;
  const { projectId, sessionId: pageSessionId } = useSessionViewContext();
  const { blockId, windowId } = useScreenBlock();

  // 屏上不止一块时,一块 ❌ 空着:空了关掉,摆上来就空的开它的对话;只剩它一块时留着「+」那一列(见 keepBlockFilled)。
  useEffect(() => {
    if (!blockId) return;
    return keepBlockFilled({
      empty: () => paneLayout.groups.length === 1 && paneLayout.groups[0].pane.tabOrder.length === 0,
      alone: () => screenLayout.order.length <= 1,
      close: () => closeScreenBlock(blockId),
      fill: () => openSessionInSessionWhenReady({ projectId, sessionId: pageSessionId, onlyIfNoTabs: true }),
    });
  }, [paneLayout, blockId, projectId, pageSessionId]);

  /**
   * 拖到别的块边上的,只有两种页签:会话自己那枚(= 整个会话挪过去)和一个 App 为自己开的那枚(= 它单独占一块)。
   * 其余附页(审阅、终端、浏览器、文件、侧边聊天)只属于这个会话,❌ 拖进别的会话。
   */
  const blockContentOf = (tabId: string): WindowableContent | null => {
    for (const { pane } of paneLayout.groups) {
      const entry = pane.entries.get(tabId);
      if (!entry) continue;
      const state = entry.state as { sessionId?: string; filePath?: string } | undefined;
      if (CHAT_TAB_KINDS.has(entry.kind) && state?.sessionId === pageSessionId) return { kind: 'session', projectId, sessionId: pageSessionId };
      // A tab that is one per task (#7317) is this task's own page: it never leaves for a block or a window of its own.
      if (parseExtensionTabKind(entry.kind) && !state?.filePath && !isTaskOwnedTab(entry)) return { kind: 'app', tabKind: entry.kind };
      return null;
    }
    return null;
  };
  /** 一个任务一份的 App 页签(#7317):❌ 单独成窗(右键里没有这一项,拖出窗外也不开)。 */
  const ownedByTask = (tabId: string): boolean => {
    for (const { pane } of paneLayout.groups) {
      const entry = pane.entries.get(tabId);
      if (entry) return isTaskOwnedTab(entry);
    }
    return false;
  };

  /**
   * 页签右键「在新窗口打开」:会话自己那枚 = 整个会话单独成窗(已经在窗里的不再开一扇),App 那枚 = 这个 App,
   * 别的附页 = 这一枚单独成窗。要打开的那枚正在某扇窗里 = 把那扇窗提到前面。
   */
  useEffect(() => {
    paneLayout.setWindowOpener((tabId) => {
      if (ownedByTask(tabId)) return null;
      const content = blockContentOf(tabId);
      if (content) return windowId ? null : () => openInWindow(content);
      return () => openTabInWindow({ projectId, sessionId: pageSessionId }, paneLayout, tabId);
    });
    paneLayout.setWindowRevealer(revealTabWindow);
    paneLayout.setPaneSizer(paneCellSize);
    return () => {
      paneLayout.setWindowOpener(null);
      paneLayout.setWindowRevealer(null);
      paneLayout.setPaneSizer(null);
    };
    // blockContentOf 每次被调用时现读页签;它闭包里认的只有这几样。
  }, [paneLayout, projectId, pageSessionId, windowId]);

  const drag = useTabDrag({
    layout: paneLayout,
    blockId,
    contentOf: blockContentOf,
    // 拖到窗口外松手 = 单独成窗:会话自己那枚 = 整个会话(已经在窗里的除外),App 那枚 = 这个 App,别的附页 = 这一枚;
    // 一个任务一份的 App 页签不成窗(#7317)。
    openWindow: (tabId) => {
      const content = blockContentOf(tabId);
      if (ownedByTask(tabId) || (content && windowId)) return null;
      return (at) => (content ? openInWindow(content, at) : openTabInWindow({ projectId, sessionId: pageSessionId }, paneLayout, tabId, at));
    },
  });

  // Each pane's conversation in front goes through the ready gate (it was the chat column's, one at a time).
  const shownChats = [
    ...new Set(
      paneLayout.groups.flatMap(({ pane }) => {
        const tab = pane.resolvedTabs.find((t) => t.isActive && CHAT_TAB_KINDS.has(t.kind));
        const sessionId = tab ? (pane.entries.get(tab.tabId)?.state as { sessionId?: string } | undefined)?.sessionId : undefined;
        return sessionId ? [sessionId] : [];
      })
    ),
  ];

  return (
    <SessionActionsProvider>
      {shownChats.map((sessionId) => (
        <SessionReadyGate key={sessionId} sessionId={sessionId} />
      ))}
      <DndContext
        sensors={drag.sensors}
        collisionDetection={edgeFirst}
        onDragStart={drag.onDragStart}
        onDragMove={drag.onDragMove}
        onDragEnd={drag.onDragEnd}
        onDragCancel={drag.onDragCancel}
      >
        <div className="h-full min-h-0 min-w-0" data-session-panes="">
          <PaneTreeView layout={paneLayout} renderPane={(paneId, first, last, part) => <PaneCell paneId={paneId} part={part} atLeftEdge={first} atWindowEdge={last} draggingTabId={drag.dragging} />} />
        </div>
        <TabDragOverlay />
      </DndContext>
    </SessionActionsProvider>
  );
});

/** One pane: its tab strip («+» right after the last tab) and its content; the top-right one carries the session's own controls. */
const PaneCell = observer(function PaneCell({
  paneId,
  part,
  atLeftEdge,
  atWindowEdge,
  draggingTabId,
}: {
  paneId: string;
  /** 'bar' = the session's one strip drawn above a pair; 'body' = a page of the pair; 'all' = both (spec session-page「并排」). */
  part: 'all' | 'bar' | 'body';
  /** 这一块左上那一格 —— 它的页签条最左是 ⋮⋮;这一块又在屏的左上时,侧栏收起要让开那枚浮动的「展开侧栏」钮。 */
  atLeftEdge: boolean;
  /** 这一块右上那一格 —— 托管这一块自己的控制(在哪打开、输出、分享、关闭这一块);这一块又在屏的右上时让开窗口控制条。 */
  atWindowEdge: boolean;
  draggingTabId: string | null;
}) {
  const sessionView = useWorkspaceViewModel();
  const { isLeftOpen } = useWorkspaceLayoutContext();
  const block = useScreenBlock();
  const { paneLayout } = sessionView;
  const group = paneLayout.groups.find((g) => g.paneId === paneId);
  if (!group) return null;
  // 拖到哪条边 = 在那一边并排(spec session-page「并排」);放不下两页的那一向不出落点。
  const splitEdges = draggingTabId === null ? [] : PANE_EDGES.filter((edge) => paneLayout.splitBlocked(paneId, draggingTabId, edge) === null);
  const focused = sessionView.focusedRegion === 'main' && paneLayout.activePaneId === paneId;
  const strip = {
    tabLeadingSlot: atLeftEdge ? <SessionGrip /> : undefined,
    tabTrailingSlot: <TabBarAddMenu />,
    actionsSlot: atWindowEdge ? <SessionBlockActions atScreenEdge={block.topRight} /> : undefined,
    reserveShellRestoreLane: atLeftEdge && block.topLeft && !block.windowId && !isLeftOpen,
    leadingReservePx: atLeftEdge && block.windowId ? auxLeadingReserve() : undefined,
  };
  if (part === 'bar') return <PaneProvider group={group} isFocusedPane={focused} passive><PaneContent part="bar" {...strip} /></PaneProvider>;
  return (
    <PaneProvider group={group} isFocusedPane={focused}>
      <SplitPaneHotkey />
      <div className="h-full min-h-0 min-w-0" onPointerDown={() => paneLayout.setActiveGroup(paneId)} data-pane-cell={paneId}>
        <PaneContent
          part={part}
          emptyState={<PaneEmptyState />}
          {...strip}
          contentOverlay={splitEdges.length > 0 ? <PaneEdgeDropZones paneId={paneId} edges={splitEdges} /> : null}
        />
      </div>
    </PaneProvider>
  );
});

/** 一格此刻画出来多大:主窗里,或单独成窗的那扇窗里(格子 id 全局不重)。量不到(没画出来)= null。 */
function paneCellSize(paneId: string): { width: number; height: number } | null {
  const documents = [document, ...[...auxWindows.windows.values()].flatMap((w) => (w.handle && !w.handle.closed ? [w.handle.document] : []))];
  for (const doc of documents) {
    const rect = doc.querySelector(`[data-pane-cell="${CSS.escape(paneId)}"]`)?.getBoundingClientRect();
    if (rect && rect.width > 0) return { width: rect.width, height: rect.height };
  }
  return null;
}

/**
 * 这一块(这个会话)自己的控制:在哪里打开项目、换模型(编程模式)、输出 / 来源。原来在聊天栏标题行右端;
 * 对话成了页签之后它们落在这一块右上那条页签条的右端(spec「页签条右端只放这一块自己的控制」)。
 * 动作对着这一块正在看的那条会话(子会话的页签在前面就是子会话)。
 */
const SessionBlockActions = observer(function SessionBlockActions({ atScreenEdge }: { atScreenEdge: boolean }) {
  const { sessionId: pageSessionId } = useSessionViewContext();
  const { paneLayout } = useWorkspaceViewModel();
  const { blockId, multi, windowId } = useScreenBlock();
  const sessionId = activeChatSessionId(paneLayout);
  const session = sessionId ? sessionRegistry.get(pageSessionId)?.sessions.get(sessionId) : undefined;
  const startupFailure = useSessionStartupFailure(sessionId ?? null);
  return (
    <TabBarActionRow atWindowEdge={atScreenEdge}>
      {/* spec session-terminal-model-switch:终端会话看不到输入框,换模型的入口在这里;通用模式的输入框里已经有一颗。
          从没起过的会话只在首启失败时摆(#7092:会员模型被拒,换一个再起);正在首启的那段不摆,换了也赶不上这一次。 */}
      {session && sessionId && sessionViewOfRuntime(session.data.runtime ?? 'pty') === 'code'
        && (session.data.providerSessionId || startupFailure) ? (
        <TerminalModelMenu
          sessionId={sessionId}
          providerId={session.data.providerId}
          recordedModel={session.data.model}
          recordedEffort={session.data.effort}
          notStarted={!session.data.providerSessionId}
        />
      ) : null}
      {/* #7167 聊天 / 编程 / 通用 —— 这一块最右(多块时在「关闭这一块」左边)。 */}
      {/* 屏上不止一块时:从这屏拿走(左边列表里还在)。单独成窗时这里是「放回咕咕」。 */}
      {multi && blockId ? <CloseBlockButton blockId={blockId} /> : null}
      {windowId ? <PutBackButton windowId={windowId} /> : null}
    </TabBarActionRow>
  );
});

/**
 * 这一块左上的 ⋮⋮:按住 = 整个会话连同它分好的格子一起挪(落在别的块边上),落在输入框上照样是一枚 @;
 * 右键 = 关闭这一块(屏上不止一块时)。
 */
const SessionGrip = observer(function SessionGrip() {
  const { translate } = useSessionMessages();
  const { projectId, sessionId } = useSessionViewContext();
  const { blockId, multi, windowId } = useScreenBlock();
  const title = sessionRegistry.get(sessionId)?.sessions.get(sessionId)?.data.title ?? '';
  const content = { kind: 'session', projectId, sessionId } as const;
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger className="flex h-full items-center">
        <BlockGrip
          label={translate('screen.grip')}
          onDragStart={(event) => startSessionBlockDrag(event, { projectId, sessionId, title })}
          // 拖到窗口外松手 = 整个会话单独成窗(已经在窗里的不再开一扇)。
          onDragEnd={(event) => {
            if (!windowId && droppedOutsideWindow(event)) openInWindow(content, { screenX: event.screenX, screenY: event.screenY });
          }}
        />
      </ContextMenu.Trigger>
      <ContextMenu.Content finalFocus={false}>
        {windowId ? (
          <MenuItem onClick={() => putBackFromWindow(windowId)}>{translate('screen.putBack')}</MenuItem>
        ) : (
          <MenuItem onClick={() => openInWindow(content)}>{translate('screen.openInWindow')}</MenuItem>
        )}
        {multi && blockId ? (
          <>
            <MenuSeparator />
            <MenuItem onClick={() => closeScreenBlock(blockId)}>{translate('screen.closeBlock')}</MenuItem>
          </>
        ) : null}
      </ContextMenu.Content>
    </ContextMenu.Root>
  );
});
