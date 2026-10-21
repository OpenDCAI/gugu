import { observer } from 'mobx-react-lite';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import IntegrationsCard from '@renderer/features/settings/components/IntegrationsCard';
import { LibraryHostProvider, machineLibraryHost } from '@renderer/features/library/library-host';
import { PageHeader } from '@renderer/lib/components/page-header';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { IntegrationsProvider } from './integrations-provider';

/**
 * 「助理 · 能力 · 连接应用」(connectors):一页就是资源库「集成」那一格的同一份 —— 连接、多账号、能力、
 * 可在哪些设备用、推荐玩法都在点开的详情里。外壳只管挂,传它看哪台机器:
 *
 *   <ConnectedAppsPage deviceId={context.cloudDeviceId} />   // 助理住的云电脑
 *   <ConnectedAppsPage deviceId={null} />                    // 这台电脑
 *
 * 连在哪台机器上,就只在那台的会话里能用 —— 所以一页只看一台,❌ 把几台的连接混成一张表。
 * 资源库里那一格照旧在(兼容入口),两处读写的是同一份。
 */
export const ConnectedAppsPage = observer(function ConnectedAppsPage({ deviceId }: { deviceId: string | null }) {
  const { translate } = useSessionMessages();
  const device = deviceId ? remoteHostsStore.device(deviceId) : null;
  // 名下没有这台(还在读设备表,或已经移除):说出来,❌ 悄悄回落成本机的连接。
  if (deviceId && !device) {
    return <p className="py-16 text-center text-sm text-foreground-muted">{translate('integrations.connectedAppsNoDevice')}</p>;
  }
  const host = machineLibraryHost(
    device
      ? {
          deviceId: device.id,
          deviceLabel: device.label,
          online: device.isOnline,
          lastSeenAt: device.lastSeenAt,
          hostKind: device.hostKind,
        }
      : null
  );
  const page = (
    <div className="space-y-8" data-testid="connected-apps-page">
      <PageHeader
        sticky
        title={translate('integrations.connectedAppsTitle')}
        description={
          device
            ? translate('integrations.connectedAppsOn', { device: device.label })
            : translate('integrations.connectedAppsDescription')
        }
      />
      <IntegrationsCard />
    </div>
  );
  return (
    <LibraryHostProvider value={host} key={host.key}>
      {/* 应用根上那份集成是本机的;看别的机器另挂一份(与资源库同一做法)。 */}
      {host.remote ? <IntegrationsProvider>{page}</IntegrationsProvider> : page}
    </LibraryHostProvider>
  );
});
