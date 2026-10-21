import { observer } from 'mobx-react-lite';
import { usePaneLayoutContext } from '../pane-layout-context';
import { isUnavailableTabResource, UnavailableTabDragPreview } from '../unavailable-tab';

export const TabDragPreview = observer(function TabDragPreview({ tabId }: { tabId: string }) {
  const paneLayout = usePaneLayoutContext();
  const group = paneLayout.groups.find((g) => g.pane.resolvedTabs.some((t) => t.tabId === tabId));
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
