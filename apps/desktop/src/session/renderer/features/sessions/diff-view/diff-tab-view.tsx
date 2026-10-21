import { observer } from 'mobx-react-lite';
import type { TabContentProps } from '@renderer/features/tabs/core/tab-provider';
import { DiffView } from './main-panel/diff-view';
import type { DiffTabResource } from './stores/diff-tab-resource';

export const TabContent = observer(function DiffTabContent({ host }: TabContentProps) {
  // 并排时屏上有两枚(spec session-page「并排」):挑自己这种里亮着的那枚。
  const activeTab = host.resolvedTabs.find((t) => t.isActive && t.kind === 'diff');
  if (!activeTab) return null;
  return <DiffView tab={activeTab.resource as DiffTabResource} />;
});
