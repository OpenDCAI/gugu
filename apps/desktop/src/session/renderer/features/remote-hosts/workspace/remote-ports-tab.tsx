// #6264 会话右侧工作区的「端口」(别的机器上的会话,只给用 SSH 装上的机器):照 VS Code 的 Ports 视图。
//
// 一行一个那台机器上的端口:端口 / 这台电脑上(转到了哪) / 程序 / 怎么发现的;悬停出动作:在浏览器打开、复制地址、
// 停止转发(或从列表拿掉)。顶上一格「转发一个端口」+ 再查一次。表的来源见 remote-ports-model.ts。
// 什么时候问那台机器:打开这一格、点「再查一次」时各一次(读 /proc/net/tcp);转着的与输出里发现的是这台电脑自己记的,
// 变了主进程推一声就重画,❌ 定时去问。
import { Cable } from '@/lib/icons';
import type { ResolvedTab, TabBarItemProps, TabEntry, TabProvider, TabResource, TabViewContext } from '@renderer/features/tabs/core/tab-provider';
import { createTabProvider } from '@renderer/features/tabs/core/tab-provider-registry';
import { registeredTabView } from '@renderer/features/tabs/core/tab-views';
import { GenericTabDragPreview, GenericTabItem } from '@renderer/features/tabs/tab-bar/generic-tab-item';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

type PortsState = { viewId: string };

class RemotePortsResource implements TabResource {
  dispose(): void {}
}

function RemotePortsTabItem({ tab, host, ctx }: TabBarItemProps<RemotePortsResource>) {
  const { translate } = useSessionMessages();
  return <GenericTabItem tab={tab} host={host} ctx={ctx} label={translate('remotePorts.tool')} preSlot={<Cable className="size-3" />} />;
}

function RemotePortsTabDragPreview({ tab: _tab }: { tab: ResolvedTab<RemotePortsResource> }) {
  const { translate } = useSessionMessages();
  return <GenericTabDragPreview preSlot={<Cable className="size-3" />} label={translate('remotePorts.tool')} />;
}

export const remotePortsTabProvider: TabProvider<'remote-ports', PortsState, RemotePortsResource, Record<string, never>> =
  createTabProvider({
    kind: 'remote-ports',
    mount: 'single',
    resourceKey: (state: PortsState) => state.viewId,
    onBeforeOpen(_args: Record<string, never>, ctx: TabViewContext): PortsState {
      return { viewId: ctx.viewId };
    },
    initialize(): RemotePortsResource {
      return new RemotePortsResource();
    },
    dispose(_entry: TabEntry<PortsState>, resource: RemotePortsResource): void {
      resource.dispose();
    },
    TabBarItem: RemotePortsTabItem,
    TabBarItemDragPreview: RemotePortsTabDragPreview,
    TabContent: registeredTabView('remote-ports'),
  });
