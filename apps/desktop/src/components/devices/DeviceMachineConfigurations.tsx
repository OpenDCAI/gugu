import type { Device } from '@gugu/core/shared/types/chat'
import { useTranslation } from 'react-i18next'
import { deviceVersionLabel } from '@/lib/deviceVersionLabel'
import { formatRelativeTime } from '@/lib/relativeTime'
import { SettingsGroup, SettingsRow } from '../settings/SettingsPrimitives'
import { Button } from '../ui/Button'

export type DeviceConfigurationActions = { remove: (device: Device) => void; uninstall: (device: Device) => void; canUninstall: (device: Device) => boolean }

/** Registered versions share the same public naming on desktop and phone. */
export function DeviceMachineConfigurations({ devices = [], actions }: { devices?: readonly Device[]; actions?: DeviceConfigurationActions }) {
  const { t } = useTranslation('settings')
  if (devices.length < 2) return null
  return <SettingsGroup title={t('devices.configurations')} data-testid="device-machine-configurations">
    {devices.map(device => {
      const seen = formatRelativeTime(device.last_seen_at, { dateAfterDays: 30 })
      const status = device.is_online ? t('devices.online') : seen ? t('devices.lastSeen', { time: seen }) : t('devices.offline')
      return <SettingsRow key={device.device_id} title={deviceVersionLabel(device.tier,t)}
        data-testid={`device-configuration-${device.device_id}`} description={[status, device.capabilities.app_version].filter(Boolean).join(' · ')}
        control={actions && !device.is_current_device ? <span className="flex flex-wrap gap-2">
          <Button variant="ghost" size="sm" data-testid={`device-configuration-remove-${device.device_id}`} onClick={() => actions.remove(device)}>{t('devices.menu.remove')}</Button>
          {actions.canUninstall(device) && <Button variant="ghost" size="sm" data-testid={`device-configuration-uninstall-${device.device_id}`} onClick={() => actions.uninstall(device)}>{t('devices.menu.uninstall')}</Button>}
        </span> : undefined} />
    })}
  </SettingsGroup>
}
