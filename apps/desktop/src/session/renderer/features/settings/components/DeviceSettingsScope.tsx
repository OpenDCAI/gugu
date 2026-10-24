// 任务里的机器组:选哪台机器,项目目录、git 行为与 tmux 就读写哪台机器。
import { observer } from 'mobx-react-lite';
import { useMemo, type ReactNode } from 'react';
import { DeviceScopeNoticeLine, useSelectedRemoteDevice } from '@renderer/features/remote-hosts/device-scope-picker';
import { deviceScopeNotice } from '@renderer/features/remote-hosts/device-scope-notice';
import { settingsDeviceStore } from '@renderer/features/remote-hosts/device-scope-store';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import {
  createMachineSettingsHost,
  LOCAL_SETTINGS_HOST,
  SettingsHostProvider,
  useSettingsHost,
  type SettingsHost,
} from '../settings-host';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';

export const DeviceSettingsScope = observer(function DeviceSettingsScope({ children }: { children: ReactNode }) {
  const selected = useSelectedRemoteDevice(settingsDeviceStore);
  const deviceId = selected?.deviceId ?? null;
  const label = selected?.device.label ?? '';
  const online = selected?.device.isOnline ?? false;
  const lastSeenAt = selected?.device.lastSeenAt ?? null;
  const host = useMemo<SettingsHost>(
    () =>
      deviceId
        ? createMachineSettingsHost({ deviceId, deviceLabel: label, online, lastSeenAt })
        : LOCAL_SETTINGS_HOST,
    [deviceId, label, online, lastSeenAt]
  );
  return (
    // 换机器 = 换一份:上一台没存完的输入不带到下一台。
    <SettingsHostProvider value={host} key={host.key}>
      {children}
    </SettingsHostProvider>
  );
});

/** 看的是别的机器、它此刻给不出这一组设置时那一句话(离线 / server 太旧 / 问不通)。 */
export function DeviceSettingsNotice({
  error,
  hasData,
  onRetry,
}: {
  error: unknown;
  hasData: boolean;
  onRetry?: () => void;
}) {
  const { translate } = useSessionMessages();
  const { remote } = useSettingsHost();
  const notice = deviceScopeNotice({ remote, error, hasData, now: Date.now(), cloud: remoteHostsStore.cloudScope(remote?.deviceId) }, translate);
  return notice ? <DeviceScopeNoticeLine notice={notice} onRetry={onRetry} /> : null;
}
