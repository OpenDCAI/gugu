import { Fragment, useEffect, useMemo, type ReactNode } from 'react';
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

/** Tasks and conversations render the same tree. Narrowing changes visibility, never the saved tree or history. */
export const PaneTreeView = observer(function PaneTreeView({ layout, renderPane }: { layout: PaneLayoutStore; renderPane: RenderPane }) {
  const size = useMemo(createPaneDimensionSink, [layout]);
  const narrow = !!size.dimensions && size.dimensions.width < minExtent(layout.layout, 'width', MIN_PANE_WIDTH_PX);
  useEffect(() => { layout.setNarrow(narrow); return () => layout.setNarrow(false); }, [layout, narrow]);
  return <PaneDimensionProvider sink={size}>
    <div className="relative h-full min-h-0 min-w-0" data-pane-tree-narrow={narrow || undefined}>
      <Tree node={layout.layout} layout={layout} narrow={narrow} renderPane={renderPane} first={cornerPane(layout.layout, 'top-left')} last={cornerPane(layout.layout, 'top-right')} />
    </div>
  </PaneDimensionProvider>;
});

const Tree = observer(function Tree({ node, layout, narrow, renderPane, first, last }: {
  node: PaneLayoutNode; layout: PaneLayoutStore; narrow: boolean; renderPane: RenderPane; first: string; last: string;
}) {
  if (node.type === 'pane') return <RetainedTabContent visible={!narrow || node.paneId === layout.activePaneId} className="h-full min-h-0 min-w-0">{renderPane(node.paneId, narrow || node.paneId === first, narrow || node.paneId === last)}</RetainedTabContent>;
  return <Cut node={node} layout={layout} narrow={narrow} renderPane={renderPane} first={first} last={last} />;
});

const Cut = observer(function Cut({ node, layout, narrow, renderPane, first, last }: {
  node: Extract<PaneLayoutNode, { type: 'split' }>; layout: PaneLayoutStore; narrow: boolean; renderPane: RenderPane; first: string; last: string;
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
      const shown = !narrow || paneOrder(child).includes(layout.activePaneId);
      return <Fragment key={childId(child)}>
        {index > 0 && <ResizableHandle disabled={narrow} style={narrow ? { display: 'none' } : undefined} onPointerDown={(event) => { if (narrow || event.button !== 0) return; dragging.current = true; setDragShield(true); }} onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag} onDoubleClick={() => layout.equalizeSplit(node.id)} />}
        <ResizablePanel id={childId(child)} defaultSize={`${node.sizes[index] ?? 0}%`} minSize={narrow ? 0 : `${node.orientation === 'horizontal' ? minExtent(child, 'width', MIN_PANE_WIDTH_PX) : minExtent(child, 'height', MIN_PANE_HEIGHT_PX)}px`} style={narrow ? { position: 'absolute', inset: 0, width: '100%', height: '100%', minWidth: 0, minHeight: 0, visibility: shown ? 'visible' : 'hidden', pointerEvents: shown ? undefined : 'none' } : undefined} inert={!shown} aria-hidden={!shown || undefined}>
          <Tree node={child} layout={layout} narrow={narrow} renderPane={renderPane} first={first} last={last} />
        </ResizablePanel>
      </Fragment>;
    })}
  </ResizablePanelGroup>;
});
