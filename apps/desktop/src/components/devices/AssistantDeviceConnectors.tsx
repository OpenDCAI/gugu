/**
 * #7199 「连接应用」里跟着设备走的两段(owner 10-15「连接要分清在哪」;
 * 10-16 起画在全局设置「咕咕 → 连接应用」里,components/settings/ConnectorsSection.tsx):
 * - 本机 = 这台电脑「能做的事」那一页本身(授权存在这台上,❌ 另写一份);
 * - 其他设备 = 别的设备登记的动作,按「哪一项 · 经哪台」一行;授权只存在那台上,这里只看,开关得去那台改。
 * 它住的那台云端宿主不在这里(它没有设备上的数据,也不给人看)。
 */
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Device } from '@gugu/core/shared/types/chat'
import { ChevronRight } from '@/lib/icons'
import { otherDeviceConnectors, type OtherDeviceConnector } from '../../lib/deviceConnectors'
import { desktopIpc } from '../../platform/desktopIpc'
import { useDevicesStore } from '../../store/devicesContext'
import { Chip } from '../ui/Chip'
import { DeviceActionsPage, GroupIcon, ThisDeviceActions } from '../settings/DeviceActionsPage'
import { SettingsGroup, SettingsNote, SettingsPage, SettingsRow } from '../settings/SettingsPrimitives'
import { useDeviceActionGroupText } from '../settings/deviceActionGroupText'

export function ThisDeviceConnectors() {
  const { t } = useTranslation('settings')
  // 网页版没有「这台设备」:本机的数据只有咕咕电脑 App 连得了。
  if (!desktopIpc())
    return (
      <SettingsPage data-testid="assistant-connectors-device">
        <SettingsNote>{t('devices.connectors.thisUnsupported')}</SettingsNote>
      </SettingsPage>
    )
  return <ThisDeviceActions bare />
}

export function OtherDeviceConnectors({ cloudDeviceId }: { cloudDeviceId: string | null }) {
  const { t } = useTranslation('settings')
  const text = useDeviceActionGroupText()
  const { devices, phones } = useDevicesStore()
  const [open, setOpen] = useState<string | null>(null)
  const all = useMemo<Device[]>(() => [...devices, ...(phones ?? [])], [devices, phones])
  const { authorized, connectable } = useMemo(() => otherDeviceConnectors(all, cloudDeviceId), [all, cloudDeviceId])

  const opened = open ? [...authorized, ...connectable].find(({ device }) => device.device_id === open)?.device ?? null : null
  if (opened) return <DeviceActionsPage device={opened} isThisDevice={false} onBack={() => setOpen(null)} />

  const row = ({ device, group }: OtherDeviceConnector, detail: string) => (
    <SettingsRow
      key={`${device.device_id}:${group}`}
      data-testid={`assistant-connector-other-${group}`}
      leading={<GroupIcon group={{ id: group }} size="row" />}
      title={text.name(group)}
      description={detail}
      control={(
        <span className="flex items-center gap-2">
          <Chip tone={device.is_online ? 'ok' : undefined}>{device.is_online ? t('devices.online') : t('devices.offline')}</Chip>
          <ChevronRight size={16} />
        </span>
      )}
      onClick={() => setOpen(device.device_id)}
    />
  )
  return (
    <SettingsPage data-testid="assistant-connectors-other">
      <SettingsNote>{t('devices.connectors.otherNote')}</SettingsNote>
      {authorized.length === 0 && connectable.length === 0 && (
        <SettingsGroup>
          <SettingsRow description={t('devices.connectors.otherEmpty')} />
        </SettingsGroup>
      )}
      {authorized.length > 0 && (
        <SettingsGroup title={t('devices.deviceActions.connected')} data-testid="assistant-connectors-other-authorized">
          {authorized.map((entry) => row(entry, t('devices.connectors.through', { name: text.name(entry.group), device: entry.device.label })))}
        </SettingsGroup>
      )}
      {connectable.length > 0 && (
        <SettingsGroup title={t('devices.deviceActions.available')} data-testid="assistant-connectors-other-available">
          {connectable.map((entry) => row(entry, t('devices.connectors.connectThere', { device: entry.device.label })))}
        </SettingsGroup>
      )}
    </SettingsPage>
  )
}
