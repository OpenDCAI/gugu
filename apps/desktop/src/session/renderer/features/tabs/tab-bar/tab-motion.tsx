import { type DragEndEvent, type DragMoveEvent, type DropAnimation } from '@dnd-kit/core';
import { Component, type ReactNode, type RefObject } from 'react';
import { DUR_MED_MS, EASE } from '@/styles/motion';

type Point = { x: number; y: number };

/** One movement for layout FLIP, making room during a drag, and the overlay's final landing. */
export function animateTabMove(node: HTMLElement, from: Point, to: Point): Animation | undefined {
  const view = node.ownerDocument.defaultView;
  if (view?.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (Math.abs(from.x - to.x) < 0.5 && Math.abs(from.y - to.y) < 0.5) return;
  return node.animate([
    { translate: `${from.x}px ${from.y}px` },
    { translate: `${to.x}px ${to.y}px` },
  ], { duration: DUR_MED_MS, easing: `cubic-bezier(${EASE.join(',')})`, fill: 'both' });
}

/** Keep dnd-kit's pointer-following overlay; its landing uses exactly the strip's movement. */
export const tabDropAnimation: DropAnimation = async ({ active, dragOverlay }) => {
  if (!active.node.isConnected) return;
  const opacity = active.node.style.opacity;
  const destination = active.node.getBoundingClientRect();
  const animation = animateTabMove(dragOverlay.node, { x: 0, y: 0 }, {
    x: destination.left - dragOverlay.rect.left,
    y: destination.top - dragOverlay.rect.top,
  });
  if (!animation) return;
  active.node.style.opacity = '0';
  try { await animation.finished; } finally { active.node.style.opacity = opacity; }
};

/** A drag preview names its original-order destination, rather than the tab now occupying that screen position. */
export function tabDropTarget(event: DragEndEvent): string | undefined {
  return event.active.data.current?.tabReorderTarget ?? (event.over ? String(event.over.id) : undefined);
}

/** dnd-kit's event delta includes scrolling; the overlay rect retains the actual viewport movement. */
export function tabDragPoint(event: DragMoveEvent | DragEndEvent) {
  const start = event.activatorEvent as PointerEvent | null;
  const { initial, translated: rect } = event.active.rect.current;
  return start && initial && rect ? {
    start, rect, x: start.clientX + rect.left - initial.left, y: start.clientY + rect.top - initial.top,
  } : null;
}

export function stripTabNodes(scroller: HTMLElement): [string, HTMLElement][] {
  return [...scroller.querySelectorAll<HTMLElement>('.session-tab-slot')].flatMap((node) => {
    const id = node.dataset.tabid ?? node.querySelector<HTMLElement>('[data-tabid]')?.dataset.tabid;
    return id ? [[id, node] as [string, HTMLElement]] : [];
  });
}

type Props = { scroller: RefObject<HTMLDivElement | null>; order: string; activeTabId: string | undefined; children: ReactNode };

/** Snapshot before React moves keyed slots. No wrapper: slots must remain direct flex siblings. */
export class TabStripMotion extends Component<Props> {
  private animations = new Map<HTMLElement, Animation>();

  private revealActiveTab() {
    const { scroller, activeTabId } = this.props;
    if (!activeTabId) return;
    scroller.current?.querySelector<HTMLElement>(`[data-tabid="${CSS.escape(activeTabId)}"]`)
      ?.scrollIntoView({ behavior: 'instant', inline: 'nearest', block: 'nearest' });
  }

  componentDidMount() { this.revealActiveTab(); }

  private positions(): Map<string, Point> {
    const scroller = this.props.scroller.current;
    if (!scroller) return new Map();
    const origin = scroller.getBoundingClientRect();
    return new Map(stripTabNodes(scroller).filter(([, node]) => !node.dataset.tabDragging).map(([id, node]) => {
      const rect = node.getBoundingClientRect();
      return [id, { x: rect.left - origin.left + scroller.scrollLeft, y: rect.top - origin.top }] as const;
    }));
  }

  getSnapshotBeforeUpdate(previous: Props): Map<string, Point> | null {
    return previous.order === this.props.order ? null : this.positions();
  }

  componentDidUpdate(previous: Props, _state: unknown, before: Map<string, Point> | null) {
    const activeChanged = previous.activeTabId !== this.props.activeTabId;
    if (!before && !activeChanged) return;
    for (const animation of this.animations.values()) animation.cancel();
    this.animations.clear();
    // Reveal the new layout before FLIP restores the previous visual position.
    if (activeChanged) this.revealActiveTab();
    if (!before) return;
    const after = this.positions();
    const scroller = this.props.scroller.current;
    if (!scroller) return;
    for (const [id, node] of stripTabNodes(scroller)) {
      const start = before.get(id), end = after.get(id);
      if (!start || !end || node.dataset.tabDragging) continue;
      const animation = animateTabMove(node, { x: start.x - end.x, y: start.y - end.y }, { x: 0, y: 0 });
      if (!animation) continue;
      this.animations.set(node, animation);
      // Cancelled animations also reject finished; rapid reorders intentionally interrupt them.
      void animation.finished.then(() => {
        if (this.animations.get(node) !== animation) return;
        this.animations.delete(node);
        animation.cancel();
      }, () => {});
    }
  }

  componentWillUnmount() {
    for (const animation of this.animations.values()) animation.cancel();
  }

  render() { return this.props.children; }
}
