import { observer } from 'mobx-react-lite';
import { CloudBrowserPanel } from '@/components/cloudBrowser/CloudBrowserPanel';
import type { TabContentProps } from '@renderer/features/tabs/core/tab-provider';
import type { SessionTabContext } from '@renderer/features/tabs/core/session-tab-context';
import { useWorkspaceSurface } from '@renderer/features/sessions/session-view-context';
import { EmptyState } from '@renderer/lib/ui/empty-state';
import { machineRegistry } from '@renderer/lib/machine-routing';

/**
 * 「浏览器」页签(server 上的会话):只在它是这一格的当前页签时连实时画面 —— 切走 = 断开(拿着控制权就交还)。
 * 那台机器离线:这一格照样在,说「离线,上次在线 X」;回来之后自己接上。
 */
export const TabContent = observer(function CloudBrowserTabContent({ host, ctx }: TabContentProps) {
  const activeTab = host.resolvedTabs.find((tab) => tab.isActive && tab.kind === 'cloud-browser');
  const sessionCtx = ctx as SessionTabContext;
  const deviceId = machineRegistry.machineOf(sessionCtx.projectId);
  const unreachable = useWorkspaceSurface().unreachableLabel;
  if (!activeTab || !deviceId) return null;
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden" data-testid="cloud-browser-tab">
      {unreachable ? <EmptyState label={unreachable} /> : <CloudBrowserPanel deviceId={deviceId} sessionId={sessionCtx.sessionId} />}
    </div>
  );
});
