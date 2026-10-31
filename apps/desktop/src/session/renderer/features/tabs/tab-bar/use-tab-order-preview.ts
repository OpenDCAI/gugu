import { useDndMonitor } from '@dnd-kit/core';
import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { PaneStore } from '../pane-store';
import { stripTabNodes, tabDragPoint } from './tab-motion';

/** Local, reversible drag layout. The same pane rule computes both the preview and the eventual drop. */
export function useTabOrderPreview(pane: PaneStore, scrollerRef: RefObject<HTMLDivElement | null>) {
  const drag = useRef<{ from: number; centers: number[]; order: string[]; shown: string; data: { tabReorderTarget?: string } | undefined } | null>(null);
  const [target, setTarget] = useState<number | null>(null);
  // A drop can arrive before a pending preview render: expose only the committed destination.
  useLayoutEffect(() => {
    const current = drag.current;
    if (!current) return;
    current.shown = current.order[target ?? current.from];
    if (target !== null && current.data) current.data.tabReorderTarget = current.shown;
  }, [target]);
  const reset = () => { drag.current = null; setTarget(null); };
  useDndMonitor({
    onDragStart(event) {
      const id = String(event.active.id), from = pane.tabOrder.indexOf(id);
      const scroller = scrollerRef.current;
      if (from === -1 || !scroller) return;
      if (event.active.data.current) event.active.data.current.tabReorderTarget = id;
      const nodes = stripTabNodes(scroller);
      const bounds = scroller.getBoundingClientRect();
      const centers = nodes.map(([, node]) => {
        const rect = node.getBoundingClientRect();
        return rect.left + rect.width / 2 - bounds.left + scroller.scrollLeft;
      });
      drag.current = { from, centers, order: [...pane.tabOrder], shown: id, data: event.active.data.current };
    },
    onDragMove(event) {
      const current = drag.current, scroller = scrollerRef.current;
      const at = tabDragPoint(event);
      if (!current || !scroller || !event.active.data.current || !at) return;
      const bounds = scroller.getBoundingClientRect();
      if (at.x < bounds.left || at.x > bounds.right || at.y < bounds.top || at.y > bounds.bottom) {
        delete event.active.data.current.tabReorderTarget;
        setTarget(null);
        return;
      }
      const center = at.rect.left + at.rect.width / 2 - bounds.left + scroller.scrollLeft;
      let to = current.from;
      for (let i = 0; i < current.from; i++) {
        if (center < current.centers[i]) { to = i; break; }
      }
      for (let i = current.from + 1; i < current.centers.length; i++) {
        if (center > current.centers[i]) to = i;
      }
      event.active.data.current.tabReorderTarget = current.shown;
      setTarget(to);
    },
    onDragEnd: reset,
    onDragCancel: reset,
  });
  const current = drag.current;
  return target === null || !current ? pane.tabOrder : pane.previewTabOrder(current.from, target);
}
