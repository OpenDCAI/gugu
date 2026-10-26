import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { SettingsNote } from '@/components/settings/SettingsPrimitives'
import { X } from '@/lib/icons'
import { systemPermissionRows, useSystemPermissionStates } from '@/lib/systemPermissions'
import { PhoneCapabilityGroups } from '../phone-device/PhoneCapabilityGroups'
import { PHONE_ACTION_GROUPS } from '../phone-device/phoneActionCatalog'
import { PhoneAgentHostControl } from './PhoneAgentHostControl'
import { PhoneAgentSetupPermission } from './PhoneAgentSetupPermissions'
import '../phone-device/phone-device.css'

/** One permission form; completion saves presentation state and never grants an unchecked capability. */
export function PhoneAgentSetup({ ownerId, onFinish, onLater, saveError }: {
  ownerId: string
  onFinish: () => void
  onLater: () => void
  saveError: string | null
}) {
  const rows = systemPermissionRows()
  const { states, refresh } = useSystemPermissionStates(rows.map((row) => row.permission))
  return (
    <form className="gg-phone-setup" data-testid="phone-agent-setup-form" onSubmit={(event) => { event.preventDefault(); onFinish() }}>
      <header className="gg-phone-setup-header">
        <IconButton size="lg" className="gg-phone-setup-close" aria-label="关闭设置" onClick={onLater}><X /></IconButton>
        <h2 id="phone-agent-setup-heading" className="gg-phone-setup-heading">设置这台手机</h2>
        <p>按需授权，随时可改。</p>
        <div className="gg-phone-setup-summary">{rows.length} 项系统权限 · {PHONE_ACTION_GROUPS.length} 类手机能力</div>
      </header>
      <div className="gg-phone-setup-body">
        <section className="gg-phone-setup-section" aria-label="手机运行">
          <h3>手机运行</h3>
          <PhoneAgentHostControl ownerId={ownerId} setup />
        </section>
        {rows.length > 0 && <section className="gg-phone-setup-section" aria-label="系统权限">
          <h3>系统权限</h3>
          <div className="gg-phone-setup-fields">
            {rows.map(({ permission }) => <PhoneAgentSetupPermission key={permission} permission={permission} state={states[permission]} onRefresh={refresh} />)}
          </div>
        </section>}
        <PhoneCapabilityGroups ownerId={ownerId} context="setup" presentation="inline" />
      </div>
      <div className="gg-phone-setup-footer">
        {saveError && <SettingsNote role="alert" tone="danger">{saveError}</SettingsNote>}
        <Button variant="primary" type="submit" data-testid="phone-agent-setup-finish">完成设置</Button>
      </div>
    </form>
  )
}
