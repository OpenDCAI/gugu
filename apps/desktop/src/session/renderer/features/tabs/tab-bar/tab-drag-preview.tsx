import { observer } from 'mobx-react-lite';
import { DragOverlay, useDndContext } from '@dnd-kit/core';
import { usePaneLayoutContext } from '../pane-layout-context';
import { isUnavailableTabResource, UnavailableTabDragPreview } from '../unavailable-tab';
import { tabDropAnimation } from './tab-motion';

export function TabDragOverlay() {
  const { active } = useDndContext();
  return <DragOverlay dropAnimation={tabDropAnimation}>{active ? <TabDragPreview tabId={String(active.id)} /> : null}</DragOverlay>;
}

export const TabDragPreview = observer(function TabDragPreview({ tabId }: { tabId: string }) {
  const paneLayout = usePaneLayoutContext();
  const group = [...paneLayout.groups, ...paneLayout.windowPanes.values()].find((g) => g.pane.entries.has(tabId));
  const tab = group?.pane.resolvedTabs.find((t) => t.tabId === tabId);
  if (!tab || !group) return null;

  const registry = group.pane.registry;
  if (isUnavailableTabResource(tab.resource) || !registry.has(tab.kind)) {
    return <UnavailableTabDragPreview tab={tab} />;
  }
  const def = registry.get(tab.kind);
  const DragPreviewComponent = def.TabBarItemDragPreview;
  return <DragPreviewComponent tab={tab} />;
});
