import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { SettingsGroup, SettingsNote, SettingsRow } from '@/components/settings/SettingsPrimitives'
import { ChevronLeft, ChevronRight } from '@/lib/icons'
import { openPhonePermissions } from '../phone-device/phonePermissionsNavigation'
import { PhoneAgentHostControl } from './PhoneAgentHostControl'
import '../phone-device/phone-device.css'

/** Installation offers hosting; every data and Android permission is managed in My → Permissions. */
export function PhoneAgentSetup({ ownerId, onFinish, onLater, saveError }: {
  ownerId: string
  onFinish: () => void
  onLater: () => void
  saveError: string | null
}) {
  return (
    <form className="gg-phone-setup" data-testid="phone-agent-setup-form" onSubmit={event => { event.preventDefault(); onFinish() }}>
      <header className="gg-phone-setup-header"><h2 id="phone-agent-setup-heading" className="gg-phone-setup-heading">设置这台手机</h2></header>
      <div className="gg-phone-setup-body">
        <PhoneAgentHostControl ownerId={ownerId} setup />
        <SettingsGroup presentation="navigation"><SettingsRow title="权限" data-testid="phone-setup-open-permissions" control={<ChevronRight className="size-4" aria-hidden="true" />} onClick={() => { onLater(); openPhonePermissions() }} /></SettingsGroup>
      </div>
      <div className="gg-phone-setup-footer">
        {saveError && <SettingsNote role="alert" tone="danger">{saveError}</SettingsNote>}
        <div className="gg-phone-setup-navigation">
          <IconButton size="lg" className="gg-phone-setup-back" aria-label="返回咕咕" onClick={onLater}><ChevronLeft /></IconButton>
          <Button variant="primary" type="submit" data-testid="phone-agent-setup-finish">完成</Button>
        </div>
      </div>
    </form>
  )
}
