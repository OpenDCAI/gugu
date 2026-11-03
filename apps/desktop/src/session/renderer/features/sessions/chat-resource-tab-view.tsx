import { observer } from 'mobx-react-lite';
import { useCallback, useEffect } from 'react';
import { readShellSlots } from '@/lib/shellSlots';
import { requestOwnedAgentResourceHost, ownedAgentResourceSlotKey } from '@/lib/ownedAgentResources';
import type { SessionTabContext } from '../tabs/core/session-tab-context';
import type { TabContentProps } from '../tabs/core/tab-provider';
import { RetainedTabContent, useRetainedTabs } from '../tabs/retained-tab-content';
import type { Resource } from './chat-resource-tab-provider';

export const TabContent = observer(function Content({ host, ctx }: TabContentProps) {
  const tabs = host.resolvedTabs;
  const retained = useRetainedTabs(tabs.map(tab => tab.tabId), tabs.filter(tab => tab.isActive).map(tab => tab.tabId));
  return <>{tabs.filter(tab => tab.kind === 'chat-resource' && retained.has(tab.tabId)).map(tab =>
    <Slot key={tab.tabId} ctx={ctx as SessionTabContext} tabId={tab.tabId} onFocus={() => host.setActiveTab(tab.tabId)} resource={tab.resource as Resource} visible={tab.isActive} />
  )}</>;
});

function Slot({ resource, visible, style, ctx, tabId, onFocus }: { resource: Resource; visible: boolean; style?: React.CSSProperties; ctx: SessionTabContext; tabId: string; onFocus: () => void }) {
  const { chatId, sourceTabId } = resource.state;
  useEffect(() => { requestOwnedAgentResourceHost(chatId, { projectId: ctx.projectId, sessionId: ctx.sessionId }) }, [chatId, ctx.projectId, ctx.sessionId]);
  const ref = useCallback((element: HTMLDivElement | null) => readShellSlots()?.setSlot(ownedAgentResourceSlotKey(chatId, sourceTabId), element), [chatId, sourceTabId]);
  return <RetainedTabContent ref={ref} visible={visible} style={style} className="absolute inset-0 flex min-h-0 min-w-0 flex-col" data-session-chat-resource={chatId} data-pane-tab={tabId} onPointerDownCapture={onFocus} onFocusCapture={onFocus} />;
}
