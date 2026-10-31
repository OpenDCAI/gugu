import { useAuth } from '@/store/auth'
import { SettingsGroup, SettingsPage, SettingsRow } from '@/components/settings/SettingsPrimitives'
import { ChevronRight } from '@/lib/icons'
import { PhoneAgentHostControl } from '../local-agent/PhoneAgentHostControl'
import { openPhonePermissions } from './phonePermissionsNavigation'

/** Phone data is authorized per category for this phone's task Agents only. */
export function PhoneDeviceActionsPage() {
  const { user } = useAuth()
  const userId = user?.id ?? null
  if (!userId) return null
  return (
    <SettingsPage className="gg-phone-device-page" data-testid="settings-phone-device-actions">
      <PhoneAgentHostControl key={`host:${userId}`} ownerId={userId} />
      <SettingsGroup presentation="navigation"><SettingsRow title="权限" data-testid="phone-device-open-permissions" control={<ChevronRight className="size-4" aria-hidden="true" />} onClick={openPhonePermissions} /></SettingsGroup>
    </SettingsPage>
  )
}
