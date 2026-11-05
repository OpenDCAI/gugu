import { Fragment, useEffect, useId, useMemo, type CSSProperties, type ReactNode } from 'react';
import { observer } from 'mobx-react-lite';
import { useGroupRef } from 'react-resizable-panels';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@renderer/lib/ui/resizable';
import { createPaneDimensionSink, PaneDimensionProvider } from './pane-dimension-provider';
import { RetainedTabContent } from './retained-tab-content';
import { MIN_PANE_HEIGHT_PX, MIN_PANE_WIDTH_PX, type PaneLayoutStore } from './pane-layout-store';
import { cornerPane, minExtent, paneOrder, type PaneLayoutNode } from './pane-layout-tree';
import { setDragShield } from '@renderer/lib/drag-shield';
import { useRef } from 'react';

type RenderPane = (paneId: string, first: boolean, last: boolean) => ReactNode;
const childId = (node: PaneLayoutNode) => node.type === 'pane' ? `pane-${node.paneId}` : `cut-${node.id}`;

/**
 * Tasks and conversations render the same tree. Narrowing changes visibility, never the saved tree or history.
 * @@@flat-panes - the tree draws only empty, anchored cells; each pane is drawn once, keyed by its id, as a flat
 * sibling pinned to its cell (CSS anchor positioning). Splitting or closing reshapes the tree: a pane drawn inside it
 * would change parents and remount with everything in it. Drawn flat it keeps its identity, so a split costs the same
 * whatever the panes hold.
 */
export const PaneTreeView = observer(function PaneTreeView({ layout, renderPane, singlePaneId }: { layout: PaneLayoutStore; renderPane: RenderPane; singlePaneId?: string }) {
  const size = useMemo(createPaneDimensionSink, [layout]);
  const treeId = useId().replace(/[^\w-]/g, '');
  const narrow = !!size.dimensions && size.dimensions.width < minExtent(layout.layout, 'width', MIN_PANE_WIDTH_PX);
  useEffect(() => { layout.setNarrow(narrow); return () => layout.setNarrow(false); }, [layout, narrow]);
  const single = narrow || !!singlePaneId;
  const visiblePaneId = singlePaneId ?? layout.activePaneId;
  const first = cornerPane(layout.layout, 'top-left');
  const last = cornerPane(layout.layout, 'top-right');
  const anchorOf = (paneId: string) => `--pane-${treeId}-${paneId}`;
  return <PaneDimensionProvider sink={size}>
    <div className="relative h-full min-h-0 min-w-0" data-pane-tree-narrow={narrow || undefined}>
      <Tree node={layout.layout} layout={layout} narrow={single} visiblePaneId={visiblePaneId} anchorOf={anchorOf} />
      {layout.groups.map(({ paneId }) => {
        const shown = !single || paneId === visiblePaneId;
        const anchored = { position: 'absolute', positionAnchor: anchorOf(paneId), top: 'anchor(top)', bottom: 'anchor(bottom)', left: 'anchor(left)', right: 'anchor(right)' } as CSSProperties;
        return <RetainedTabContent key={paneId} visible={shown} style={anchored} className="min-h-0 min-w-0" inert={!shown} aria-hidden={!shown || undefined}>
          {renderPane(paneId, single || paneId === first, single || paneId === last)}
        </RetainedTabContent>;
      })}
    </div>
  </PaneDimensionProvider>;
});

const Tree = observer(function Tree({ node, layout, narrow, visiblePaneId, anchorOf }: {
  node: PaneLayoutNode; layout: PaneLayoutStore; narrow: boolean; visiblePaneId: string; anchorOf: (paneId: string) => string;
}) {
  if (node.type === 'pane') return <div className="h-full min-h-0 min-w-0" style={{ anchorName: anchorOf(node.paneId) } as CSSProperties} />;
  return <Cut node={node} layout={layout} narrow={narrow} visiblePaneId={visiblePaneId} anchorOf={anchorOf} />;
});

const Cut = observer(function Cut({ node, layout, narrow, visiblePaneId, anchorOf }: {
  node: Extract<PaneLayoutNode, { type: 'split' }>; layout: PaneLayoutStore; narrow: boolean; visiblePaneId: string; anchorOf: (paneId: string) => string;
}) {
  const groupRef = useGroupRef();
  const dragging = useRef(false);
  const endDrag = () => { if (dragging.current) { dragging.current = false; setDragShield(false); } };
  useEffect(() => {
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
    window.addEventListener('blur', endDrag);
    return () => { window.removeEventListener('pointerup', endDrag); window.removeEventListener('pointercancel', endDrag); window.removeEventListener('blur', endDrag); endDrag(); };
  }, []);
  const ids = node.children.map(childId);
  const idsKey = ids.join(',');
  const sizesKey = node.sizes.join(',');
  useEffect(() => {
    const handle = groupRef.current;
    if (!handle || narrow) return;
    const wanted = Object.fromEntries(ids.map((id, index) => [id, node.sizes[index] ?? 0]));
    try {
      const current = handle.getLayout();
      if (!ids.every((id) => Math.abs((current[id] ?? -1) - wanted[id]) < 0.5)) handle.setLayout(wanted);
    } catch { /* First paint uses the same default shares. */ }
  }, [idsKey, sizesKey, groupRef, narrow]);
  return <ResizablePanelGroup orientation={node.orientation} groupRef={groupRef} style={narrow ? { position: 'relative', display: 'block' } : undefined} onLayoutChanged={(sizes, meta) => {
    if (!narrow && meta.isUserInteraction) layout.setSplitSizes(node.id, ids.map((id) => sizes[id] ?? 0));
  }}>
    {node.children.map((child, index) => {
      const shown = !narrow || paneOrder(child).includes(visiblePaneId);
      return <Fragment key={childId(child)}>
        {index > 0 && <ResizableHandle disabled={narrow} style={{ zIndex: 'var(--z-pane-divider)', ...(narrow ? { display: 'none' } : {}) }} onPointerDown={(event) => { if (narrow || event.button !== 0) return; dragging.current = true; setDragShield(true); }} onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag} onDoubleClick={() => layout.equalizeSplit(node.id)} />}
        <ResizablePanel id={childId(child)} defaultSize={`${node.sizes[index] ?? 0}%`} minSize={narrow ? 0 : `${node.orientation === 'horizontal' ? minExtent(child, 'width', MIN_PANE_WIDTH_PX) : minExtent(child, 'height', MIN_PANE_HEIGHT_PX)}px`} style={narrow ? { position: 'absolute', inset: 0, width: '100%', height: '100%', minWidth: 0, minHeight: 0, visibility: shown ? 'visible' : 'hidden', pointerEvents: shown ? undefined : 'none' } : undefined} inert={!shown} aria-hidden={!shown || undefined}>
          <Tree node={child} layout={layout} narrow={narrow} visiblePaneId={visiblePaneId} anchorOf={anchorOf} />
        </ResizablePanel>
      </Fragment>;
    })}
  </ResizablePanelGroup>;
});
