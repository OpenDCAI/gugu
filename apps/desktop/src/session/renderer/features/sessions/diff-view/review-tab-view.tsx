import { observer } from 'mobx-react-lite';
import type { TabContentProps } from '@renderer/features/tabs/core/tab-provider';
import { ChangesPanel } from './changes-panel/changes-panel';

export const TabContent = observer(function ReviewTabContent({ host }: TabContentProps) {
  const reviewTabs = host.resolvedTabs.filter((tab) => tab.kind === 'review');
  if (reviewTabs.length === 0) return null;

  return <ChangesPanel isVisible={reviewTabs.some((tab) => tab.isActive)} />;
});
