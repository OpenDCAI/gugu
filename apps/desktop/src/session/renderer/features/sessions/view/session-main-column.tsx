import { DndContext } from '@dnd-kit/core';
import { observer } from 'mobx-react-lite';
import { Fragment, useEffect } from 'react';
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
import { useGroupRef } from 'react-resizable-panels';
import { ProjectTitleActions } from '@renderer/features/projects/components/project-title-actions';
import { sessionRegistry } from '@renderer/features/sessions/stores/session-registry';
import { PaneContent } from '@renderer/features/tabs/pane-content';
import { PaneProvider } from '@renderer/features/tabs/pane-context';
import { MIN_PANE_HEIGHT_PX, MIN_PANE_WIDTH_PX } from '@renderer/features/tabs/pane-layout-store';
import { edgeFirst, PANE_EDGES, PaneEdgeDropZones } from '@renderer/features/tabs/pane-edge-drop';
import { useTabDrag } from '@renderer/features/tabs/use-tab-drag';
import { cornerPane, minExtent, type PaneLayoutNode } from '@renderer/features/tabs/pane-layout-tree';
import { TabDragOverlay } from '@renderer/features/tabs/tab-bar/tab-drag-preview';
import { useWorkspaceLayoutContext } from '@renderer/lib/layout/layout-provider';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@renderer/lib/ui/context-menu';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@renderer/lib/ui/resizable';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { sessionViewOfRuntime } from '@shared/core/sessions/sessions';
import { parseExtensionTabKind } from '@shared/extensions/manifest';
import { isTaskOwnedTab } from '../../extensions/task-owned-tab';
import { openSessionInSessionWhenReady } from '../open-session-in-session';
import { PaneEmptyState } from '../pane-empty-state';
import { keepBlockFilled } from './keep-block-filled';
import { SessionModeMenu } from './session-mode-menu';
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
          <PaneTree
            node={paneLayout.layout}
            topLeftPaneId={cornerPane(paneLayout.layout, 'top-left')}
            topRightPaneId={cornerPane(paneLayout.layout, 'top-right')}
            draggingTabId={drag.dragging}
          />
        </div>
        <TabDragOverlay />
      </DndContext>
    </SessionActionsProvider>
  );
});

const childPanelId = (node: PaneLayoutNode) => (node.type === 'pane' ? `pane-${node.paneId}` : `cut-${node.id}`);

const PaneTree = observer(function PaneTree({
  node,
  topLeftPaneId,
  topRightPaneId,
  draggingTabId,
}: {
  node: PaneLayoutNode;
  topLeftPaneId: string;
  topRightPaneId: string;
  draggingTabId: string | null;
}) {
  if (node.type === 'pane') {
    return (
      <PaneCell
        paneId={node.paneId}
        atLeftEdge={node.paneId === topLeftPaneId}
        atWindowEdge={node.paneId === topRightPaneId}
        draggingTabId={draggingTabId}
      />
    );
  }
  return <PaneCut node={node} topLeftPaneId={topLeftPaneId} topRightPaneId={topRightPaneId} draggingTabId={draggingTabId} />;
});

/**
 * 一刀:几格左右并排或上下叠着,中间是可拖的分界。拖分界改份额并记住;双击分界 = 这一刀等分(spec「双击分界 = 等分」)。
 * 份额以 store 为准:等分、读回存档这类不是拖出来的改动,从这里推给分栏组件。
 */
const PaneCut = observer(function PaneCut({
  node,
  topLeftPaneId,
  topRightPaneId,
  draggingTabId,
}: {
  node: Extract<PaneLayoutNode, { type: 'split' }>;
  topLeftPaneId: string;
  topRightPaneId: string;
  draggingTabId: string | null;
}) {
  const { paneLayout } = useWorkspaceViewModel();
  const groupRef = useGroupRef();
  const ids = node.children.map(childPanelId);
  const idsKey = ids.join(',');
  const sizesKey = node.sizes.join(',');

  useEffect(() => {
    const handle = groupRef.current;
    if (!handle) return;
    const wanted = Object.fromEntries(ids.map((id, index) => [id, node.sizes[index] ?? 0]));
    try {
      const current = handle.getLayout();
      if (ids.every((id) => Math.abs((current[id] ?? -1) - wanted[id]) < 0.5)) return;
      handle.setLayout(wanted);
    } catch {
      // Not laid out yet (first paint): its defaultSize already says the same.
    }
    // ids / sizes are read through their keys: a new array every render must not re-run this.
  }, [idsKey, sizesKey, groupRef]);

  return (
    <ResizablePanelGroup
      orientation={node.orientation}
      groupRef={groupRef}
      onLayoutChanged={(layout, meta) => {
        if (meta.isUserInteraction) paneLayout.setSplitSizes(node.id, ids.map((id) => layout[id] ?? 0));
      }}
    >
      {node.children.map((child, index) => (
        <Fragment key={childPanelId(child)}>
          {index > 0 && <ResizableHandle onDoubleClick={() => paneLayout.equalizeSplit(node.id)} />}
          <ResizablePanel id={childPanelId(child)} defaultSize={`${node.sizes[index] ?? 0}%`} minSize={`${paneMinSize(child, node.orientation)}px`}>
            <PaneTree node={child} topLeftPaneId={topLeftPaneId} topRightPaneId={topRightPaneId} draggingTabId={draggingTabId} />
          </ResizablePanel>
        </Fragment>
      ))}
    </ResizablePanelGroup>
  );
});

/** One pane: its tab strip («+» right after the last tab) and its content; the top-right one carries the session's own controls. */
const PaneCell = observer(function PaneCell({
  paneId,
  atLeftEdge,
  atWindowEdge,
  draggingTabId,
}: {
  paneId: string;
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
  const splitEdges = draggingTabId === null ? [] : PANE_EDGES.filter((edge) => group.pane.pairSplitBlocked(draggingTabId, edge) === null);
  return (
    <PaneProvider group={group} isFocusedPane={sessionView.focusedRegion === 'main' && paneLayout.activePaneId === paneId}>
      <SplitPaneHotkey />
      <div className="h-full min-h-0 min-w-0" onPointerDown={() => paneLayout.setActiveGroup(paneId)} data-pane-cell={paneId}>
        <PaneContent
          emptyState={<PaneEmptyState />}
          tabLeadingSlot={atLeftEdge ? <SessionGrip /> : undefined}
          tabTrailingSlot={<TabBarAddMenu />}
          actionsSlot={atWindowEdge ? <SessionBlockActions atScreenEdge={block.topRight} /> : undefined}
          reserveShellRestoreLane={atLeftEdge && block.topLeft && !block.windowId && !isLeftOpen}
          leadingReservePx={atLeftEdge && block.windowId ? auxLeadingReserve() : undefined}
          contentOverlay={splitEdges.length > 0 ? <PaneEdgeDropZones paneId={paneId} edges={splitEdges} /> : null}
        />
      </div>
    </PaneProvider>
  );
});

/** 一格(或一刀)在这一向最少要多大:里面每格不比 MIN_PANE_WIDTH_PX / MIN_PANE_HEIGHT_PX 更窄更矮。 */
const paneMinSize = (node: PaneLayoutNode, orientation: 'horizontal' | 'vertical') =>
  orientation === 'horizontal' ? minExtent(node, 'width', MIN_PANE_WIDTH_PX) : minExtent(node, 'height', MIN_PANE_HEIGHT_PX);

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
  const { projectId, sessionId: pageSessionId } = useSessionViewContext();
  const { paneLayout } = useWorkspaceViewModel();
  const { blockId, multi, windowId } = useScreenBlock();
  const sessionId = activeChatSessionId(paneLayout);
  const session = sessionId ? sessionRegistry.get(pageSessionId)?.sessions.get(sessionId) : undefined;
  const startupFailure = useSessionStartupFailure(sessionId ?? null);
  return (
    <TabBarActionRow atWindowEdge={atScreenEdge}>
      <ProjectTitleActions projectId={projectId} />
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
      {sessionId ? <SessionModeMenu sessionId={sessionId} /> : null}
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
    <ContextMenu>
      <ContextMenuTrigger className="flex h-full items-center">
        <BlockGrip
          label={translate('screen.grip')}
          onDragStart={(event) => startSessionBlockDrag(event, { projectId, sessionId, title })}
          // 拖到窗口外松手 = 整个会话单独成窗(已经在窗里的不再开一扇)。
          onDragEnd={(event) => {
            if (!windowId && droppedOutsideWindow(event)) openInWindow(content, { screenX: event.screenX, screenY: event.screenY });
          }}
        />
      </ContextMenuTrigger>
      <ContextMenuContent finalFocus={false}>
        {windowId ? (
          <ContextMenuItem onClick={() => putBackFromWindow(windowId)}>{translate('screen.putBack')}</ContextMenuItem>
        ) : (
          <ContextMenuItem onClick={() => openInWindow(content)}>{translate('screen.openInWindow')}</ContextMenuItem>
        )}
        {multi && blockId ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => closeScreenBlock(blockId)}>{translate('screen.closeBlock')}</ContextMenuItem>
          </>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
});
