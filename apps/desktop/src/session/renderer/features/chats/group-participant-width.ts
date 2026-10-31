import type { GroupImperativeHandle } from 'react-resizable-panels';
import type { PaneLayoutNode } from '@renderer/features/tabs/pane-layout-tree';
import { MIN_PANE_WIDTH_PX } from '@renderer/features/tabs/pane-store';
import type { GroupParticipantPanes } from './group-participant-panes';

type Split = Extract<PaneLayoutNode, { type: 'split' }>;

export function participantSplitSizes(node: Split, at: number, rightWidth: number, extent: number): number[] {
  const total = node.sizes[at - 1] + node.sizes[at];
  const minShare = Math.min(0.5, MIN_PANE_WIDTH_PX / extent);
  const right = Math.min(1 - minShare, Math.max(minShare, rightWidth / extent)) * total;
  const sizes = [...node.sizes];
  sizes[at - 1] = total - right;
  sizes[at] = right;
  return sizes;
}

/** Container resizes change the displayed ratio, never the user's saved pixel width. */
export function observeGroupParticipantWidth(element: HTMLElement, node: Split, handle: GroupImperativeHandle, panes: GroupParticipantPanes): () => void {
  const resize = () => {
    const pair = panes.pairIn(node);
    if (!pair) return;
    const widths = Array.from(element.children)
      .filter(child => child.hasAttribute('data-panel'))
      .map(child => child.getBoundingClientRect().width);
    if (widths.length !== node.children.length || widths.some(width => !Number.isFinite(width) || width <= 0)) return;
    // The library may have clamped these panels to different shares. Convert the saved pair share
    // against the whole group's pixel budget, not the pair's currently clamped DOM width.
    const total = node.sizes[pair.targetIndex - 1] + node.sizes[pair.targetIndex];
    const extent = widths.reduce((sum, width) => sum + width, 0) * total / 100;
    const sizes = participantSplitSizes(node, pair.targetIndex, panes.rightWidth, extent);
    const wanted = Object.fromEntries(node.children.map((child, index) => [child.type === 'pane' ? `block-panel-${child.paneId}` : `block-cut-${child.id}`, sizes[index]]));
    const current = handle.getLayout();
    if (Object.keys(wanted).some(id => Math.abs((current[id] ?? -1) - wanted[id]) > 0.001)) handle.setLayout(wanted);
  };
  const observer = new ResizeObserver(resize);
  observer.observe(element);
  resize();
  return () => observer.disconnect();
}
