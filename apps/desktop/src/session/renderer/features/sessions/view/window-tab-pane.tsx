import { DndContext, type DragEndEvent, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { observer } from 'mobx-react-lite';
import { auxLeadingReserve, PutBackButton } from '@renderer/app/aux-window-host';
import { auxWindows } from '@renderer/app/aux-windows';
import { PaneContent } from '@renderer/features/tabs/pane-content';
import { PaneProvider } from '@renderer/features/tabs/pane-context';
import { ShellTitlebarDragRegion } from '@renderer/lib/components/titlebar/shell-titlebar';
import { SessionContentGate } from '../main-panel';
import { useWorkspaceViewModel } from '../session-view-context';
import { TabBarActionRow } from '../titlebar-actions';

/**
 * 单独成窗的一枚页签(spec session-page「一屏几块」:拖到窗口外 = 单独成窗,一枚页签也行):窗里一条页签条只有它,
 * 右端「放回咕咕」,下面是它的内容 —— 和它在会话页一格里时是同一个东西(终端还是那个进程)。
 * 页签条就是标题栏(mac 让开红绿灯)。✕ 掉它 = 关掉这枚页签,窗跟着关。
 * 会话没 ready(被闲置回收、正在重新准备)时窗里和会话页一样画那一档的屏,见 SessionContentGate。
 */
export const WindowTabPane = observer(function WindowTabPane({ windowId, paneId }: { windowId: string; paneId: string }) {
  return (
    <div className="relative flex h-full min-h-0 w-full flex-col bg-background text-foreground" data-aux-window={windowId}>
      <ShellTitlebarDragRegion />
      <SessionContentGate>
        <WindowTabPaneContent windowId={windowId} paneId={paneId} />
      </SessionContentGate>
    </div>
  );
});

const WindowTabPaneContent = observer(function WindowTabPaneContent({ windowId, paneId }: { windowId: string; paneId: string }) {
  const { paneLayout } = useWorkspaceViewModel();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const group = paneLayout.windowPanes.get(paneId);
  if (!group) return null;
  const focused = auxWindows.focusedWindowId === windowId;

  // 窗里只有这一格:拖页签只在这条页签条里换顺序。
  const handleDragEnd = (event: DragEndEvent) => {
    const over = event.over ? String(event.over.id) : null;
    if (!over) return;
    const order = group.pane.tabOrder;
    const from = order.indexOf(String(event.active.id));
    const to = order.indexOf(over);
    if (from !== -1 && to !== -1 && from !== to) group.pane.reorderTabs(from, to);
  };

  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      <PaneProvider group={group} isFocusedPane={focused}>
        <div className="h-full min-h-0 min-w-0" data-window-tab-pane={paneId}>
          <PaneContent
            leadingReservePx={auxLeadingReserve()}
            actionsSlot={
              <TabBarActionRow atWindowEdge fixedCluster={false}>
                <PutBackButton windowId={windowId} />
              </TabBarActionRow>
            }
          />
        </div>
      </PaneProvider>
    </DndContext>
  );
});
