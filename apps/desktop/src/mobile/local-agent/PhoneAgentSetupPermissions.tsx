import { useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Sheet } from '@/components/ui/Sheet'
import { SettingsNote } from '@/components/settings/SettingsPrimitives'
import { rendererLogger } from '@/lib/log'
import { messageForUser } from '@/lib/userFacingError'
import { changeSystemPermission, useSystemPermissionStates } from '@/lib/systemPermissions'
import { PhoneCapabilityGroups } from '../phone-device/PhoneCapabilityGroups'
import { usePhoneDeviceSettings } from '../phone-device/phoneDeviceSettings'
import { PhoneSheetHandle } from '../PhoneSheetHandle'

type SetupPermission = 'notifications' | 'batteryOptimization'
const LABELS = { notifications: '开启消息通知', batteryOptimization: '允许后台运行' }
const SETTINGS_LABELS = { notifications: '前往通知设置', batteryOptimization: '前往电池设置' }

/** Opening and skipping only read state. The primary action explicitly requests permission. */
export function PhoneAgentSetupPermission({ permission, onContinue, continueLabel }: { permission: SetupPermission; onContinue: () => void; continueLabel: string }) {
  const { states, refresh, failed } = useSystemPermissionStates([permission])
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const state = states[permission]
  const act = async () => {
    if (pending || failed || !state) return
    setPending(true)
    setError(null)
    try {
      if (!(await changeSystemPermission(permission, state))) setError('没能打开系统设置，请稍后重试。')
    } catch (cause) {
      rendererLogger('actions/PhoneAgentSetupPermissions').error({ error: cause }, 'action failed')
      setError(messageForUser(cause))
    } finally {
      await refresh()
      setPending(false)
    }
  }
  return (
    <div className="gg-phone-setup-action">
      <Button variant="primary" disabled={pending || (!failed && !state)} data-testid={`phone-setup-${permission}`}
        onClick={() => { if (failed) void refresh(); else if (state === 'granted') onContinue(); else void act() }}>
        {failed ? '重新读取权限' : pending ? '正在设置' : !state ? '正在读取权限'
          : state === 'granted' ? continueLabel
            : state === 'prompt' ? LABELS[permission] : SETTINGS_LABELS[permission]}
      </Button>
      {failed && <SettingsNote role="alert" tone="danger">读取系统权限失败</SettingsNote>}
      {error && <SettingsNote role="alert" tone="danger">{error}</SettingsNote>}
    </div>
  )
}

/** The guide shows one entry. Categories and explicit grants remain in their existing settings UI. */
export function PhoneAgentSetupTools({ ownerId }: { ownerId: string }) {
  const [open, setOpen] = useState(false)
  const settings = usePhoneDeviceSettings(ownerId)
  const selected = settings.enabled ? Object.values(settings.groups).filter(Boolean).length : 0
  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)} aria-haspopup="dialog" data-testid="phone-setup-choose-capabilities">
        {selected ? '管理手机能力' : '选择手机能力'}
      </Button>
      {open && <Sheet onClose={() => setOpen(false)} ariaLabel="手机能力" mobileFitContent testId="phone-setup-capabilities">
        <div className="gg-phone-capability-sheet">
          <PhoneSheetHandle onDismiss={() => setOpen(false)} />
          <div className="gg-phone-capability-sheet-body"><PhoneCapabilityGroups ownerId={ownerId} context="setup" /></div>
        </div>
      </Sheet>}
    </>
  )
}
