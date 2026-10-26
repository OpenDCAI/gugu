import { useAuth } from '@/store/auth'
import { SettingsPage } from '@/components/settings/SettingsPrimitives'
import { PhoneAgentHostControl } from '../local-agent/PhoneAgentHostControl'
import { PhonePermissionsList } from './PhonePermissionsList'

/** Phone data is authorized per category for this phone's task Agents only. */
export function PhoneDeviceActionsPage() {
  const { user } = useAuth()
  const userId = user?.id ?? null
  if (!userId) return null
  return (
    <SettingsPage className="gg-phone-device-page" data-testid="settings-phone-device-actions">
      <PhoneAgentHostControl key={`host:${userId}`} ownerId={userId} />
      <PhonePermissionsList key={`permissions:${userId}`} ownerId={userId} />
    </SettingsPage>
  )
}
