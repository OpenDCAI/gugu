import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/store/auth'
import { formatRelativeTime } from '@/lib/relativeTime'
import { rendererLogger } from '@/lib/log'
import { BookOpen, MonitorSmartphone } from '@/lib/icons'
import { Button } from '@/components/ui/Button'
import { Switch } from '@/components/ui/Switch'
import { SettingsGroup, SettingsNote, SettingsPage, SettingsRow } from '@/components/settings/SettingsPrimitives'
import { PhoneAgentHostControl } from '../local-agent/PhoneAgentHostControl'
import { phoneAgentAvailable } from '../local-agent/nativeAgent'
import { openPhoneAgentSetup } from '../local-agent/PhoneAgentSetupState'
import { PhoneCapabilityGroups } from './PhoneCapabilityGroups'
import { setPhoneDeviceEnabled, usePhoneDeviceSettings } from './phoneDeviceSettings'
import { disconnectPhoneDevice, usePhoneDevice, type PhoneActionCall, type PhoneDeviceLink } from './phoneDeviceRuntime'

const log = rendererLogger('mobile/phone-device')
const LINK_KEYS: Record<PhoneDeviceLink['state'], string> = {
  off: 'devices.phoneActions.linkOff',
  connecting: 'devices.phoneActions.linkConnecting',
  online: 'devices.phoneActions.linkOnline',
  error: 'devices.phoneActions.linkError',
}

/** Hosting and phone tools remain independent opt-ins under the existing device settings entry. */
export function PhoneDeviceActionsPage() {
  const { t } = useTranslation('settings')
  const { user } = useAuth()
  const userId = user?.id ?? null
  const settings = usePhoneDeviceSettings(userId)
  const device = usePhoneDevice()
  const [disconnectFailed, setDisconnectFailed] = useState(false)
  const [changing, setChanging] = useState(false)

  if (!userId) return null

  const toggleMaster = async (on: boolean) => {
    if (changing) return
    setDisconnectFailed(false)
    setPhoneDeviceEnabled(userId, on)
    if (on) return
    setChanging(true)
    try {
      const { removed, retainedForHost } = await disconnectPhoneDevice(userId)
      if (!removed && !retainedForHost) setDisconnectFailed(true)
    } catch (cause) {
      log.warn({ error: String(cause) }, 'phone tools disconnect failed')
      setDisconnectFailed(true)
    } finally {
      setChanging(false)
    }
  }

  return (
    <SettingsPage className="gg-phone-device-page" data-testid="settings-phone-device-actions">
      <SettingsNote>{t('devices.phoneActions.intro')}</SettingsNote>
      <SettingsGroup
        title="手机工具"
        footer={(
          <>
            {settings.enabled && <SettingsNote>{t('devices.phoneActions.keepAliveNote')}</SettingsNote>}
            {disconnectFailed && <SettingsNote tone="danger" role="alert">{t('devices.phoneActions.disconnectFailed')}</SettingsNote>}
          </>
        )}
      >
        <SettingsRow
          data-testid="phone-device-master"
          data-link={settings.enabled ? device.link.state : 'off'}
          leading={<MonitorSmartphone className="size-5 gg-phone-setting-icon" aria-hidden="true" />}
          title={t('devices.phoneActions.master')}
          description={(
            <>
              <div role="status">{changing ? '正在断开手机工具连接' : t(LINK_KEYS[settings.enabled ? device.link.state : 'off'])}</div>
              <div>只有已连接的能力可以被调用，与手机 Agent 分开设置。</div>
            </>
          )}
          control={<Switch checked={settings.enabled} disabled={changing} onCheckedChange={(on) => void toggleMaster(on)} aria-label={t('devices.phoneActions.master')} />}
        />
      </SettingsGroup>

      <PhoneAgentHostControl key={userId} ownerId={userId} />
      {phoneAgentAvailable() && (
        <SettingsGroup presentation="navigation">
          <SettingsRow
            leading={<BookOpen className="size-5 gg-phone-setting-icon" aria-hidden="true" />}
            title="手机 Agent 设置引导"
            description="运行 Agent、消息提醒和手机能力。"
            control={<Button size="sm" onClick={() => openPhoneAgentSetup(userId)}>继续设置</Button>}
          />
        </SettingsGroup>
      )}

      {settings.enabled && (
        <>
          <PhoneCapabilityGroups key={userId} ownerId={userId} />
          <SettingsGroup title={t('devices.deviceActions.recent')} data-testid="phone-device-recent">
            {device.recent.length === 0
              ? <SettingsRow description={t('devices.deviceActions.recentEmpty')} />
              : device.recent.map((call) => <RecentCallRow key={call.callId} call={call} />)}
          </SettingsGroup>
        </>
      )}
    </SettingsPage>
  )
}

function RecentCallRow({ call }: { call: PhoneActionCall }) {
  const { t } = useTranslation('settings')
  return (
    <SettingsRow
      data-call-ok={call.ok === undefined ? 'running' : String(call.ok)}
      data-call-code={call.code ?? undefined}
      title={call.title}
      description={[
        formatRelativeTime(call.startedAt),
        call.caller?.name ? t('devices.deviceActions.byCaller', { name: call.caller.name }) : null,
        call.ok === undefined
          ? t('devices.deviceActions.recentRunning')
          : call.ok
            ? t('devices.deviceActions.recentOk')
            : t('devices.deviceActions.recentFailed', { message: call.message ?? call.code ?? '' }),
      ].filter(Boolean).join(' · ')}
    />
  )
}
