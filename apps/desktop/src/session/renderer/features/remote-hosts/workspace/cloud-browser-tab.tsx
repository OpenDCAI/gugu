// #7199 server 上的 agent 用的浏览器(那台机器上的 Chrome):任务页「浏览器」页签里看、接管、交还、停止。
// 只给 server 类机器上的会话(本机会话的浏览器页签是本机 webview,见 features/browser)。
// 聊天页 ❌ 浮浏览器小窗(owner 10-28):画面、接管、停止只在这个页签里。
import { Globe } from '@/lib/icons';
import type { ResolvedTab, TabBarItemProps, TabEntry, TabProvider, TabResource, TabViewContext } from '@renderer/features/tabs/core/tab-provider';
import { createTabProvider } from '@renderer/features/tabs/core/tab-provider-registry';
import { registeredTabView } from '@renderer/features/tabs/core/tab-views';
import { GenericTabDragPreview, GenericTabItem } from '@renderer/features/tabs/tab-bar/generic-tab-item';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

type CloudBrowserTabState = { viewId: string };

class CloudBrowserTabResource implements TabResource {
  dispose(): void {}
}

function CloudBrowserTabItem({ tab, host, ctx }: TabBarItemProps<CloudBrowserTabResource>) {
  const { translate } = useSessionMessages();
  return <GenericTabItem tab={tab} host={host} ctx={ctx} label={translate('workspace.browser')} preSlot={<Globe className="size-3" />} />;
}

function CloudBrowserTabDragPreview({ tab: _tab }: { tab: ResolvedTab<CloudBrowserTabResource> }) {
  const { translate } = useSessionMessages();
  return <GenericTabDragPreview preSlot={<Globe className="size-3" />} label={translate('workspace.browser')} />;
}

export const cloudBrowserTabProvider: TabProvider<'cloud-browser', CloudBrowserTabState, CloudBrowserTabResource, Record<string, never>> =
  createTabProvider({
    kind: 'cloud-browser',
    mount: 'single',
    resourceKey: (state: CloudBrowserTabState) => state.viewId,
    onBeforeOpen(_args: Record<string, never>, ctx: TabViewContext): CloudBrowserTabState {
      return { viewId: ctx.viewId };
    },
    initialize(): CloudBrowserTabResource {
      return new CloudBrowserTabResource();
    },
    dispose(_entry: TabEntry<CloudBrowserTabState>, resource: CloudBrowserTabResource): void {
      resource.dispose();
    },
    TabBarItem: CloudBrowserTabItem,
    TabBarItemDragPreview: CloudBrowserTabDragPreview,
    TabContent: registeredTabView('cloud-browser'),
  });
