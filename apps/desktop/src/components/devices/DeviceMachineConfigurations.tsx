import type { Device } from '@gugu/core/shared/types/chat'
import { useTranslation } from 'react-i18next'
import { deviceVersionLabel } from '@/lib/deviceVersionLabel'
import { formatRelativeTime } from '@/lib/relativeTime'
import { SettingsGroup, SettingsRow } from '../settings/SettingsPrimitives'
import { Check } from '@/lib/icons'
import { Button } from '../ui/Button'

export type DeviceConfigurationActions = { remove: (device: Device) => void; uninstall: (device: Device) => void; canUninstall: (device: Device) => boolean }

/** Registered versions share the same public naming on desktop and phone. */
export function DeviceMachineConfigurations({ devices = [], actions, selectedDeviceId, onSelect }: { devices?: readonly Device[]; actions?: DeviceConfigurationActions; selectedDeviceId?: string; onSelect?: (device: Device) => void }) {
  const { t } = useTranslation('settings')
  if (devices.length < 2) return null
  return <SettingsGroup title={t('devices.configurations')} data-testid="device-machine-configurations">
    {devices.map(device => {
      const seen = formatRelativeTime(device.last_seen_at, { dateAfterDays: 30 })
      const status = device.is_online ? t('devices.online') : seen ? t('devices.lastSeen', { time: seen }) : t('devices.offline')
      return <div key={device.device_id} className="[&+div]:border-t [&+div]:border-[var(--border)]"><SettingsRow title={deviceVersionLabel(device.tier,t)}
        className="device-machine-version" data-testid={`device-configuration-${device.device_id}`} onClick={onSelect ? () => onSelect(device) : undefined}
        aria-pressed={onSelect ? device.device_id === selectedDeviceId : undefined}
        data-selected={onSelect && device.device_id === selectedDeviceId || undefined}
        control={onSelect && device.device_id === selectedDeviceId ? <Check size={16} aria-hidden="true" /> : undefined} description={[status, device.capabilities.app_version].filter(Boolean).join(' · ')}
      />{actions && !device.is_current_device ? <div className="flex flex-wrap justify-end gap-2 px-4 pb-3">
          <Button variant="ghost" size="sm" data-testid={`device-configuration-remove-${device.device_id}`} onClick={() => actions.remove(device)}>{t('devices.remove.version.confirm')}</Button>
          {actions.canUninstall(device) && <Button variant="ghost" size="sm" data-testid={`device-configuration-uninstall-${device.device_id}`} onClick={() => actions.uninstall(device)}>{t('devices.menu.uninstall')}</Button>}
        </div> : null}</div>
    })}
  </SettingsGroup>
}
