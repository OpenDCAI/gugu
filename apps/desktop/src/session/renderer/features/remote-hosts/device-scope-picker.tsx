// #6264 分机器的模块(资源库、已安排、设置里的通用 / 仓库 / 存储)那一个机器选择器,以及那台机器此刻给不出东西时的那一句话。
//
// 选择器就是全 app 共用的那一个(`MachinePicker`,页标题尺寸):本机在前、在线的、离线的(淡着、写「离线 · X 前」)。
// 一个模块**一个**选择,挂在模块层(`DeviceScopeProvider`),模块里每一页的标题右边画同一个选择器
// (`PageHeader` 读它);❌ 挂在左栏列头下、搜索框旁、设置行里,❌ 按页各选各的。
import { observer } from 'mobx-react-lite';
import { useEffect, useMemo, type ReactNode } from 'react';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { PageScopeProvider, type PageScope } from '@renderer/lib/components/page-header';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { RemoteHostDevice } from '@/session/shared/remote-hosts';
import type { DeviceScopeNotice } from './device-scope-notice';
import { LOCAL_DEVICE_SCOPE, deviceScopeTrayDevices, type DeviceScopeStore } from './device-scope-store';
import { MachinePicker } from './machine-picker';
import { useWakeCloudOnce } from './use-wake-cloud-once';

export type SelectedRemoteDevice = {
  deviceId: string;
  device: RemoteHostDevice;
};

/** 这个模块此刻看的是哪台别的机器;本机(或选的那台不在名下、桥没装好)= null。observer 里调。 */
export function useSelectedRemoteDevice(store: DeviceScopeStore): SelectedRemoteDevice | null {
  useEffect(() => remoteHostsStore.start(), []);
  const deviceId = store.effective((id) => remoteHostsStore.hosts.has(id));
  const device = deviceId === LOCAL_DEVICE_SCOPE ? null : remoteHostsStore.device(deviceId);
  // #7199 模块顶上选了一台睡着的云电脑 = 要看它、在它上面做事:叫醒它(每次选中一次),醒了页面自己读出来。
  useWakeCloudOnce(device ? deviceId : null, device ? (device.cloudComputer === 'asleep' ? 'asleep' : 'other') : null);
  return device ? { deviceId, device } : null;
}

export const DeviceScopePicker = observer(function DeviceScopePicker({
  store,
  variant = 'inline',
}: {
  store: DeviceScopeStore;
  /** sidebar = 资源库左栏列头下那一格(TeamSwitcher 形)。 */
  variant?: 'inline' | 'sidebar';
}) {
  const { translate } = useSessionMessages();
  useEffect(() => remoteHostsStore.start(), []);
  const machines = deviceScopeTrayDevices(
    translate('task.deviceLocal'),
    [...remoteHostsStore.hosts.values()].map(({ device }) => ({
      device,
      connection: remoteHostsStore.connectionState(device.id),
    }))
  );
  return (
    <MachinePicker
      machines={machines}
      selectedId={store.effective((id) => remoteHostsStore.hosts.has(id))}
      onSelect={(deviceId) => store.select(deviceId)}
      onAddMachine={remoteHostsStore.canAddMachine ? () => remoteHostsStore.openAddMachine() : undefined}
      offlineSelectable
      variant={variant}
    />
  );
});

/**
 * 模块层挂这一份:看别的机器时,里面每一页标题下的说明写出它的名字。
 * `inTitle`(缺省)= 选择器画在页标题右边(已安排:整个模块就一页);
 * 资源库、设置不画在子页上 —— owner:「设备是资源库级别的」「资源库改了,你设置页也改啊」,选择器在左栏列头下只有一个。
 */
export const DeviceScopeProvider = observer(function DeviceScopeProvider({
  store,
  inTitle = true,
  children,
}: {
  store: DeviceScopeStore;
  inTitle?: boolean;
  children: ReactNode;
}) {
  const selected = useSelectedRemoteDevice(store);
  const deviceLabel = selected?.device.label ?? null;
  const scope = useMemo<PageScope>(
    () => ({ control: inTitle ? <DeviceScopePicker store={store} /> : null, deviceLabel }),
    [store, inTitle, deviceLabel]
  );
  return <PageScopeProvider value={scope}>{children}</PageScopeProvider>;
});

/** 那一句话;能重试的,「再试一次」是句子里的一段强调色文字,❌ 底下另摆一颗按钮。 */
export function DeviceScopeNoticeLine({ notice, onRetry }: { notice: DeviceScopeNotice; onRetry?: () => void }) {
  const { translate } = useSessionMessages();
  return (
    <p className="m-0 px-3 pt-6 pb-2 text-sm text-foreground-muted" data-testid="device-scope-notice" data-kind={notice.kind}>
      {notice.text}
      {notice.retry && onRetry ? (
        <>
          {' '}
          <button
            type="button"
            className="cursor-pointer text-foreground-info underline-offset-2 hover:underline"
            onClick={onRetry}
          >
            {translate('deviceScope.retry')}
          </button>
        </>
      ) : null}
    </p>
  );
}
