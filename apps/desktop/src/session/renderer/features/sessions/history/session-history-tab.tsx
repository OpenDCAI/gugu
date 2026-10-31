import { observer } from 'mobx-react-lite';
import type { TabBarItemProps, TabResource } from '@renderer/features/tabs/core/tab-provider';
import { createTabProvider } from '@renderer/features/tabs/core/tab-provider-registry';
import { registeredTabView } from '@renderer/features/tabs/core/tab-views';
import { GenericTabDragPreview, GenericTabItem } from '@renderer/features/tabs/tab-bar/generic-tab-item';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

export interface SessionHistoryResource extends TabResource { sessionId: string }

function HistoryTabItem(props: TabBarItemProps<SessionHistoryResource>) {
  const { translate } = useSessionMessages();
  return <GenericTabItem {...props} label={translate('globalSearch.taskHistory')} />;
}

function HistoryDragPreview() {
  const { translate } = useSessionMessages();
  return <GenericTabDragPreview label={translate('globalSearch.taskHistory')} />;
}

export const sessionHistoryTabProvider = createTabProvider({
  kind: 'session-history', mount: 'single', isPersistent: () => false,
  resourceKey: (state: { sessionId: string }) => state.sessionId,
  onBeforeOpen: (args: { sessionId: string }) => ({ sessionId: args.sessionId }),
  initialize(entry): SessionHistoryResource { return { sessionId: entry.state.sessionId, dispose() {} }; },
  dispose() {},
  TabBarItem: observer(HistoryTabItem), TabBarItemDragPreview: HistoryDragPreview,
  TabContent: registeredTabView('session-history'),
});
