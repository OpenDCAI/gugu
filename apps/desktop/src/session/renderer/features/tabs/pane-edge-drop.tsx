import type { CollisionDetection } from '@dnd-kit/core';
import { pointerWithin, useDroppable } from '@dnd-kit/core';
import { PANE_EDGE_DROP_PREFIX, paneEdgeDropId } from './pane-layout-store';
import type { PaneEdge } from './pane-layout-tree';
import { cn } from '@renderer/utils/utils';

/**
 * 边上的落点压过整格:指针落在某一格的边缘区里就是「分出一格」,哪怕它同时也在那一格里。
 * 几条边的边缘区在角上重叠时,取指针离得最近的那条边。
 */
export const edgeFirst: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  const pointer = args.pointerCoordinates;
  const edges = hits.filter((hit) => String(hit.id).startsWith(PANE_EDGE_DROP_PREFIX));
  if (edges.length === 0 || !pointer) return hits;
  const distance = (id: string) => {
    const rect = args.droppableRects.get(id);
    if (!rect) return Number.POSITIVE_INFINITY;
    const edge = /^pane-edge-(left|right|top|bottom)-/.exec(id)?.[1];
    if (edge === 'left') return pointer.x - rect.left;
    if (edge === 'right') return rect.left + rect.width - pointer.x;
    if (edge === 'top') return pointer.y - rect.top;
    return rect.top + rect.height - pointer.y;
  };
  return [[...edges].sort((a, b) => distance(String(a.id)) - distance(String(b.id)))[0]];
};

export const PANE_EDGES: readonly PaneEdge[] = ['left', 'right', 'top', 'bottom'];

/**
 * 拖页签时一格四边的落点:落在哪一边,就在那一边分出一格,新格占这一格的一半 —— 指着时就把那一半画出来,
 * 松手前看得到结果。边缘区占这一格那一向的约五分之一(最少 32px、最多 120px),正中留给「搬进这一格」。
 */
export function PaneEdgeDropZones({ paneId, edges }: { paneId: string; edges: readonly PaneEdge[] }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-30" data-pane-edge-zones="">
      {edges.map((edge) => (
        <PaneEdgeDropZone key={edge} paneId={paneId} edge={edge} />
      ))}
    </div>
  );
}

const ZONE = 'clamp(32px, 22%, 120px)';

function PaneEdgeDropZone({ paneId, edge }: { paneId: string; edge: PaneEdge }) {
  const { setNodeRef, isOver } = useDroppable({ id: paneEdgeDropId(edge, paneId) });
  const zone =
    edge === 'left'
      ? { left: 0, top: 0, bottom: 0, width: ZONE }
      : edge === 'right'
        ? { right: 0, top: 0, bottom: 0, width: ZONE }
        : edge === 'top'
          ? { left: 0, right: 0, top: 0, height: ZONE }
          : { left: 0, right: 0, bottom: 0, height: ZONE };
  const half =
    edge === 'left'
      ? 'inset-y-0 left-0 w-1/2'
      : edge === 'right'
        ? 'inset-y-0 right-0 w-1/2'
        : edge === 'top'
          ? 'inset-x-0 top-0 h-1/2'
          : 'inset-x-0 bottom-0 h-1/2';
  return (
    <>
      <div ref={setNodeRef} className="absolute" style={zone} data-pane-edge={edge} />
      {isOver && (
        <div
          className={cn('absolute rounded-[var(--radius-control)] border border-foreground/20 bg-foreground/10', half)}
          data-pane-edge-preview={edge}
        />
      )}
    </>
  );
}

