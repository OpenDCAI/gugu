import { observer } from 'mobx-react-lite';
import type { TabContentProps } from '@renderer/features/tabs/core/tab-provider';
import { StoredTranscriptView } from './stored-transcript-view';
import type { SessionHistoryResource } from './session-history-tab';

export const TabContent = observer(function HistoryTabContent({ host }: TabContentProps) {
  const active = host.resolvedTabs.find(tab => tab.isActive && tab.kind === 'session-history');
  return active ? <StoredTranscriptView key={(active.resource as SessionHistoryResource).sessionId}
    sessionId={(active.resource as SessionHistoryResource).sessionId} /> : null;
});
