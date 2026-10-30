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
    const pairBlocks = node.children.slice(pair.targetIndex - 1, pair.targetIndex + 1);
    const widths = pairBlocks.map(child => child.type === 'pane'
      ? element.querySelector<HTMLElement>(`[data-screen-block="${child.paneId}"]`)?.getBoundingClientRect().width ?? 0 : 0);
    if (widths.some(width => !Number.isFinite(width) || width <= 0)) return;
    const sizes = participantSplitSizes(node, pair.targetIndex, panes.rightWidth, widths[0] + widths[1]);
    const wanted = Object.fromEntries(node.children.map((child, index) => [child.type === 'pane' ? `block-panel-${child.paneId}` : `block-cut-${child.id}`, sizes[index]]));
    const current = handle.getLayout();
    if (Object.keys(wanted).some(id => Math.abs((current[id] ?? -1) - wanted[id]) > 0.001)) handle.setLayout(wanted);
  };
  const observer = new ResizeObserver(resize);
  observer.observe(element);
  resize();
  return () => observer.disconnect();
}
