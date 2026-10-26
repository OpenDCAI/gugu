import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { PaneHeader } from '@/components/ui/Pane'
import { Sheet } from '@/components/ui/Sheet'
import { SettingsGroup, SettingsNote } from '@/components/settings/SettingsPrimitives'
import { ChevronRight, X } from '@/lib/icons'
import { rendererLogger } from '@/lib/log'
import { platform } from '@/platform'
import { PHONE_ACTION_GROUPS, type PhoneActionGroup } from './phoneActionCatalog'
import { PhoneCapabilityRow, type PhoneCapabilityAction, type PhoneCapabilityReadState } from './PhoneCapabilityRow'
import { connectPhoneActionGroup, openPhonePermissionSettings, requestPhoneRequirement } from './phonePermissionActions'
import { refreshPhoneDevice, usePhoneDevice } from './phoneDeviceRuntime'
import { readPhoneDeviceSettings, setPhoneActionGroup, usePhoneDeviceSettings } from './phoneDeviceSettings'
import { usePhonePermissionReporter } from './usePhonePermissionReporter'
import './phone-device.css'

const log = rendererLogger('mobile/phone-capabilities')

/** The settings page and installation guide share both permission actions and their real OS state. */
export function PhoneCapabilityGroups({ ownerId, context = 'settings', presentation = 'sheet' }: { ownerId: string; context?: 'settings' | 'setup'; presentation?: 'sheet' | 'inline' | 'summary' }) {
  const { t } = useTranslation('settings')
  const settings = usePhoneDeviceSettings(ownerId)
  const reportChoice = usePhonePermissionReporter(ownerId)
  const { os } = usePhoneDevice()
  const [readState, setReadState] = useState<PhoneCapabilityReadState>('loading')
  const [busy, setBusy] = useState<PhoneActionGroup | null>(null)
  const [error, setError] = useState<{ group: PhoneActionGroup; message: string } | null>(null)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const testPrefix = context === 'setup' ? 'phone-setup' : 'phone-device'
  const detailsId = `${testPrefix}-capability-details`

  const refresh = useCallback(async () => {
    setReadState('loading')
    try {
      await refreshPhoneDevice()
      setReadState('ready')
    } catch (cause) {
      setReadState('failed')
      log.warn({ error: String(cause) }, 'phone permission state refresh failed')
    }
  }, [])

  useEffect(() => {
    void refresh()
    return platform.subscribeAppForeground(() => void refresh(), () => setReadState('failed'))
  }, [refresh])

  const run = async (group: PhoneActionGroup, action: PhoneCapabilityAction) => {
    if (busy !== null) return
    setError(null)
    if (action.kind === 'disconnect') {
      setPhoneActionGroup(ownerId, group, false)
      reportChoice('group-enabled', false, group)
      return
    }
    if (readState !== 'ready' || !os) return
    setBusy(group)
    try {
      if (action.kind === 'connect') await connectPhoneActionGroup(ownerId, group, os, { enableDevice: context === 'setup' })
      else if (action.kind === 'grant') await requestPhoneRequirement(action.requirement, os)
      else await openPhonePermissionSettings(action.target)
    } catch (cause) {
      const message = action.kind === 'settings'
        ? t('devices.phoneActions.settingsUnreachable', { name: action.name })
        : t('devices.deviceActions.connectFailed', { message: cause instanceof Error ? cause.message : String(cause) })
      setError({ group, message })
      log.warn({ group, action: action.kind, error: String(cause) }, 'phone permission action failed')
    } finally {
      await refresh()
      if (action.kind === 'connect' && readPhoneDeviceSettings(ownerId).groups[group]) reportChoice('group-enabled', true, group)
      setBusy(null)
    }
  }

  return (
    <div className="gg-phone-capabilities">
      <SettingsGroup title="手机能力" note={presentation === 'summary' ? undefined : presentation === 'inline' ? '仅连接你要用的能力，系统会逐项询问。' : '按需连接，你自己的 Agent 才能使用。随时可以关闭。'}>
        {PHONE_ACTION_GROUPS.map((group) => (
          <PhoneCapabilityRow
            key={group}
            group={group}
            presentation={presentation}
            connected={settings.enabled && settings.groups[group]}
            os={os}
            readState={readState}
            busy={busy}
            error={error?.group === group ? error.message : null}
            testPrefix={testPrefix}
            onAction={(action) => void run(group, action)}
            onRetry={() => void refresh()}
          />
        ))}
      </SettingsGroup>
      {presentation !== 'summary' && readState === 'failed' && (
        <div className="gg-phone-permission-feedback" role="alert">
          <SettingsNote tone="danger">读取系统权限失败，暂时无法连接或授权。</SettingsNote>
          <Button size="sm" variant="ghost" onClick={() => void refresh()}>重试</Button>
        </div>
      )}
      {presentation !== 'summary' && <div className="gg-phone-capability-details">
        <Button variant="ghost" size="sm" aria-haspopup="dialog" onClick={() => setDetailsOpen(true)}>
          权限与使用说明
          <ChevronRight className="size-4" aria-hidden="true" />
        </Button>
        {detailsOpen && <Sheet onClose={() => setDetailsOpen(false)} ariaLabel="权限与使用说明" mobileFitContent testId={detailsId}>
          <div className="gg-phone-capability-sheet">
            <div className="gg-phone-sheet-handle" aria-hidden="true" />
            <PaneHeader mobile title="权限与使用说明" titleLevel="page" actions={<IconButton size="md" aria-label="关闭权限说明" onClick={() => setDetailsOpen(false)}><X /></IconButton>} />
            <div className="gg-phone-capability-sheet-body gg-phone-capability-prose">
              <p>{t('devices.phoneActions.thisNote')}</p>
              <p>扫码和录音时才申请相机或麦克风。读取共享录音不会启动麦克风。</p>
              <p>启用手机 Agent 或跳过引导，都不会授权手机数据。能力需要你逐项连接。</p>
              <p>通知读取、勿扰控制和咕咕自己的消息提醒，分别授权。</p>
            </div>
          </div>
        </Sheet>}
      </div>}
    </div>
  )
}
