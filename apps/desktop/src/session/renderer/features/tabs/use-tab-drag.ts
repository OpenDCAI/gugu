import { type DragEndEvent, type DragMoveEvent, type DragStartEvent, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { useState } from 'react';
import type { ScreenBlockContent } from '@renderer/app/screen-layout';
import { blockDropPreview, dropOnScreen, resolveBlockDrop, screenBlockElement, setBlockDropPreview } from '@renderer/app/screen-layout-actions';
import { setDragShield } from '@renderer/lib/drag-shield';
import type { PaneLayoutStore } from './pane-layout-store';
import { tabDragPoint, tabDropTarget } from './tab-bar/tab-motion';

/**
 * Dragging a tab of a block's strip (spec session-page「一屏几块」), a task's or a chat's: within the block it is the
 * engine's (reorder, an edge = beside); out of the block, a tab that is something of its own on the screen (`contentOf`)
 * lands on another block's edge; out of the window it opens in a window of its own (`openWindow`, null = it cannot).
 */
export function useTabDrag({
  layout,
  blockId,
  contentOf,
  landed,
  openWindow,
}: {
  layout: PaneLayoutStore;
  blockId: string | null;
  /** What this tab is as a block of its own; null: it stays in this block. */
  contentOf: (tabId: string) => ScreenBlockContent | null;
  /** After it landed on another block (a chat's App page leaves the chat's strip). */
  landed?: (tabId: string) => void;
  /** How it opens in a window of its own, dropped out of this one; null: it does not. */
  openWindow: (tabId: string) => ((at: { screenX: number; screenY: number }) => void) | null;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const [dragging, setDragging] = useState<string | null>(null);
  const onDragStart = (event: DragStartEvent) => {
    setDragShield(true);
    setDragging(String(event.active.id));
  };
  // 指针出了这一块:落点归这一屏(别的块的四条边);还在这一块里:归这一块自己的格子。
  const onDragMove = (event: DragMoveEvent) => {
    const content = contentOf(String(event.active.id));
    const at = tabDragPoint(event);
    if (!content || !blockId || !at) return;
    const own = screenBlockElement(blockId)?.getBoundingClientRect();
    const inOwn = own !== undefined && at.x >= own.left && at.x <= own.right && at.y >= own.top && at.y <= own.bottom;
    setBlockDropPreview(inOwn ? null : resolveBlockDrop(at.x, at.y, content));
  };
  const onDragEnd = (event: DragEndEvent) => {
    setDragShield(false);
    setDragging(null);
    const tabId = String(event.active.id);
    const toBlock = blockDropPreview.get();
    setBlockDropPreview(null);
    const content = contentOf(tabId);
    // 插 @ 的落点只有原生拖拽(左边一行、⋮⋮)画得出来;页签这条拖拽从不写它,这里只是让类型说清楚。
    if (toBlock && !('mention' in toBlock) && content) {
      dropOnScreen(toBlock, content);
      landed?.(tabId);
      return;
    }
    // 拖到窗口外松手 = 单独成窗。
    const at = tabDragPoint(event);
    const open = at ? openWindow(tabId) : null;
    if (at && open) {
      const view = (at.start.target as Node | null)?.ownerDocument?.defaultView ?? window;
      if (at.x < 0 || at.y < 0 || at.x > view.innerWidth || at.y > view.innerHeight) {
        open({ screenX: at.start.screenX + at.x - at.start.clientX, screenY: at.start.screenY + at.y - at.start.clientY });
        return;
      }
    }
    const target = tabDropTarget(event);
    if (target) layout.handleDragEnd(tabId, target);
  };
  const onDragCancel = () => {
    setDragShield(false);
    setDragging(null);
    setBlockDropPreview(null);
  };
  return { sensors, dragging, onDragStart, onDragMove, onDragEnd, onDragCancel };
}
