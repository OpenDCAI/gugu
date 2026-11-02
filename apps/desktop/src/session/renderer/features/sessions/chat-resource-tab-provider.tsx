import { reaction } from 'mobx';
import { observer } from 'mobx-react-lite';
import { useCallback, useContext, useEffect } from 'react';
import { Paperclip } from '@/lib/icons';
import { chatTabSlotKey, readShellSlots } from '@/lib/shellSlots';
import { requestOwnedAgentResourceHost } from '@/lib/ownedAgentResources';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import type { SessionTabContext } from '../tabs/core/session-tab-context';
import { panelItemKey, type PanelItem } from '../chats/chat-tabs/chat-panel-item';
import { panelTabOf, closeChatTab, openPanelItem } from '../chats/chat-tabs/chat-layouts';
import { createTabProvider } from '../tabs/core/tab-provider-registry';
import type { TabEntry, TabHandle, TabResource, TabContentProps } from '../tabs/core/tab-provider';
import { GenericTabDragPreview, GenericTabItem } from '../tabs/tab-bar/generic-tab-item';
import { PairPlacementContext } from '../tabs/pair-placement-context';
import { RetainedTabContent, useRetainedTabs } from '../tabs/retained-tab-content';

type State = { chatId: string; sourceTabId: string; item: PanelItem };
class Resource implements TabResource {
  private readonly stop: () => void;
  constructor(private readonly entry: TabEntry<State>, handle: TabHandle) {
    if (!this.panel) {
      const restored = openPanelItem(this.state.chatId, this.state.item);
      if (!restored) throw new Error('The chat resource could not be restored');
      this.state.sourceTabId = restored;
    }
    this.stop = reaction(() => this.panel !== null, exists => { if (!exists) void handle.close({ force: true }); });
  }
  get state() { return this.entry.state; }
  get panel() { return panelTabOf(this.state.chatId, this.state.sourceTabId); }
  get title() { return this.panel?.item.title || translateSessionMessage('workspace.files'); }
  closeSource() { this.stop(); closeChatTab(this.state.chatId, this.state.sourceTabId); }
  dispose() { this.stop(); }
}

const Content = observer(function Content({ host, ctx }: TabContentProps) {
  const tabs = host.resolvedTabs;
  const retained = useRetainedTabs(tabs.map(tab => tab.tabId), tabs.filter(tab => tab.isActive).map(tab => tab.tabId));
  const placement = useContext(PairPlacementContext);
  return <>{tabs.filter(tab => tab.kind === 'chat-resource' && retained.has(tab.tabId)).map(tab =>
    <Slot key={tab.tabId} ctx={ctx as SessionTabContext} tabId={tab.tabId} onFocus={() => host.setActiveTab(tab.tabId)} resource={tab.resource as Resource} visible={tab.isActive} style={tab.isActive ? placement?.(tab.tabId) ?? undefined : undefined} />
  )}</>;
});

function Slot({ resource, visible, style, ctx, tabId, onFocus }: { resource: Resource; visible: boolean; style?: React.CSSProperties; ctx: SessionTabContext; tabId: string; onFocus: () => void }) {
  const { chatId, sourceTabId } = resource.state;
  useEffect(() => { requestOwnedAgentResourceHost(chatId, { projectId: ctx.projectId, sessionId: ctx.sessionId }) }, [chatId, ctx.projectId, ctx.sessionId]);
  const ref = useCallback((element: HTMLDivElement | null) => readShellSlots()?.setSlot(chatTabSlotKey(chatId, sourceTabId), element), [chatId, sourceTabId]);
  return <RetainedTabContent ref={ref} visible={visible} style={style} className="absolute inset-0 flex min-h-0 min-w-0 flex-col" data-session-chat-resource={chatId} data-pane-tab={tabId} onPointerDownCapture={onFocus} onFocusCapture={onFocus} />;
}

/** A resource tab has no IM transcript: its only body is the shell's authorized file/App portal. */
export const chatResourceTabProvider = createTabProvider<'chat-resource', State, Resource>({
  kind: 'chat-resource',
  mount: 'single',
  placesPairItself: true,
  resourceKey: state => `${state.chatId}:${panelItemKey(state.item)}`,
  isPersistent: state => state.item.kind !== null,
  initialize: (entry, handle) => new Resource(entry, handle),
  dispose: (_entry, resource) => resource.dispose(),
  onBeforeClose: (_entry, resource) => { resource.closeSource(); return true; },
  TabBarItem: observer(({ tab, host, ctx }) => <GenericTabItem tab={tab} host={host} ctx={ctx} label={tab.resource.title} preSlot={<Paperclip size={14} />} />),
  TabBarItemDragPreview: observer(({ tab }) => <GenericTabDragPreview label={tab.resource.title} preSlot={<Paperclip size={14} />} />),
  TabContent: Content,
});
