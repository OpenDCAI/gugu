import { reaction } from 'mobx';
import { observer } from 'mobx-react-lite';
import { Paperclip } from '@/lib/icons';
import { ownedAgentResourceTabs } from '@/lib/ownedAgentResources';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { panelItemKey, type PanelItem } from '../chats/chat-tabs/chat-panel-item';
import { createTabProvider } from '../tabs/core/tab-provider-registry';
import type { TabEntry, TabHandle, TabResource } from '../tabs/core/tab-provider';
import { GenericTabDragPreview, GenericTabItem } from '../tabs/tab-bar/generic-tab-item';
import { registeredTabView } from '../tabs/core/tab-views';

type State = { chatId: string; sourceTabId: string; item: PanelItem };
export class Resource implements TabResource {
  private readonly stop: () => void;
  constructor(private readonly entry: TabEntry<State>, handle: TabHandle) {
    if (!this.panel) {
      const restored = ownedAgentResourceTabs().open(this.state.chatId, this.state.item);
      if (!restored) throw new Error('The chat resource could not be restored');
      this.state.sourceTabId = restored;
    }
    this.stop = reaction(() => this.panel !== null, exists => { if (!exists) void handle.close({ force: true }); });
  }
  get state() { return this.entry.state; }
  get panel() { return ownedAgentResourceTabs().read(this.state.chatId, this.state.sourceTabId); }
  get title() { return this.panel?.item.title || translateSessionMessage('workspace.files'); }
  closeSource() { this.stop(); ownedAgentResourceTabs().close(this.state.chatId, this.state.sourceTabId); }
  dispose() { this.stop(); }
}

/** A resource tab has no IM transcript: its only body is the shell's authorized file/App portal. */
export const chatResourceTabProvider = createTabProvider<'chat-resource', State, Resource>({
  kind: 'chat-resource',

  resourceKey: state => `${state.chatId}:${panelItemKey(state.item)}`,
  isPersistent: state => state.item.kind !== null,
  initialize: (entry, handle) => new Resource(entry, handle),
  dispose: (_entry, resource) => resource.dispose(),
  onBeforeClose: (_entry, resource) => { resource.closeSource(); return true; },
  TabBarItem: observer(({ tab, host, ctx }) => <GenericTabItem tab={tab} host={host} ctx={ctx} label={tab.resource.title} preSlot={<Paperclip size={14} />} />),
  TabBarItemDragPreview: observer(({ tab }) => <GenericTabDragPreview label={tab.resource.title} preSlot={<Paperclip size={14} />} />),
  TabContent: registeredTabView('chat-resource'),
});
