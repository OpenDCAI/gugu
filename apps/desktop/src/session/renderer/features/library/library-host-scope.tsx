// #6264 弹窗(集成连接、GitHub 连接 / 设备码)挂在应用根上,不在资源库那棵树里 —— 拿不到资源库选的那台机器。
// 打开它的那一页把自己的 `LibraryHost` 作为参数带过来,弹窗里用这一层重新挂上,弹窗里的取数钩子就问同一台机器。
// 弹窗开着时那台机器掉线了:里面的动作一起灰(与打开它的那一格同一条「离线只读」),❌ 点了才报失败。
import { observer } from 'mobx-react-lite';
import type { ReactNode } from 'react';
import { IntegrationsProvider } from '@renderer/features/integrations/integrations-provider';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { LibraryHostProvider, type LibraryHost } from './library-host';

export const LibraryHostScope = observer(function LibraryHostScope({
  host,
  children,
}: {
  host?: LibraryHost | null;
  children: ReactNode;
}) {
  // 本机(或没带):应用根上那一份就是本机的,原样用。
  if (!host?.remote) return <>{children}</>;
  const online = remoteHostsStore.device(host.remote.deviceId)?.isOnline ?? host.remote.online;
  return (
    <LibraryHostProvider value={host}>
      <IntegrationsProvider>
        <fieldset disabled={!online} className="contents" data-testid="library-host-scope">
          {children}
        </fieldset>
      </IntegrationsProvider>
    </LibraryHostProvider>
  );
});
