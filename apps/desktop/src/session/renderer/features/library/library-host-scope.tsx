// #6264 弹窗(集成连接、GitHub 连接 / 设备码)挂在应用根上,不在资源库那棵树里 —— 拿不到资源库选的那台机器。
// 打开它的那一页把自己的 `LibraryHost` 作为参数带过来,弹窗里用这一层重新挂上,弹窗里的取数钩子就问同一台机器。
// 助理授权动作自带宿主准备流程，不能因设备休眠在入口把它禁用。
import { observer } from 'mobx-react-lite';
import type { ReactNode } from 'react';
import { IntegrationsProvider } from '@renderer/features/integrations/integrations-provider';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { LibraryHostProvider, type LibraryHost } from './library-host';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

export const LibraryHostScope = observer(function LibraryHostScope({
  host,
  children,
}: {
  host?: LibraryHost | null;
  children: ReactNode;
}) {
  const { translate } = useSessionMessages();
  // A supplied local owner host carries its own account metadata and actions.
  if (!host) return <>{children}</>;
  const online = !host.remote || (remoteHostsStore.device(host.remote.deviceId)?.isOnline ?? host.remote.online);
  const unavailable = !online && !host.prepareAssistantAction;
  return (
    <LibraryHostProvider value={host}>
      <IntegrationsProvider>
        {unavailable && host.remote ? <p role="status" className="text-xs text-foreground-muted">{translate('deviceScope.unreachable',{ device: host.remote.deviceLabel })}</p> : null}
        <fieldset disabled={unavailable} className="contents" data-testid="library-host-scope">
          {children}
        </fieldset>
      </IntegrationsProvider>
    </LibraryHostProvider>
  );
});
