import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { PermissionState } from '@capacitor/core'
import { useAuth } from '../../store/auth'
import { platform } from '../../platform'
import { formatRelativeTime } from '../../lib/relativeTime'
import { rendererLogger } from '../../lib/log'
import { Button } from '../../components/ui/Button'
import { Chip } from '../../components/ui/Chip'
import { SettingsGroup, SettingsNote, SettingsPage, SettingsRow, Toggle } from '../../components/settings/SettingsPrimitives'
import {
  PHONE_ACTION_GROUPS,
  missingRequirements,
  type PhoneActionGroup,
  type PhoneRequirement,
} from './phoneActionCatalog'
import { HEALTH_TYPES, nativePhoneActions, type PhoneRuntimePermission, type PhoneSettingsTarget } from './nativePhoneActions'
import { nativePhoneData, phoneDataAllowed } from './phoneDataActions'
import { setPhoneActionGroup, setPhoneDeviceEnabled, thisPhoneDeviceId, usePhoneDeviceSettings } from './phoneDeviceSettings'
import { reportAssistantAppChange } from '../../components/assistant/assistant-app-client'
import { useMyAssistant } from '../../lib/myAssistant'
import { machineRpc } from '../agent-watch/sessionpage-rpc'
import { disconnectPhoneDevice, refreshPhoneDevice, usePhoneDevice, type PhoneActionCall, type PhoneDeviceLink } from './phoneDeviceRuntime'

const log = rendererLogger('mobile/phone-device')

/**
 * #7199 手机当设备「我的 → 这台手机」。与桌面的「这台电脑能做的事」(DeviceActionsPage)同一个结构、
 * 同一份词(「连接应用」页):按组「已连接 / 可连接」,一组一个「连接 / 断开」,「连接」顺手弹系统授权框,
 * 系统没给就当场给「去授权」;底下是最近调用。
 * 放在「我的」里单独一项,❌ 像桌面那样做成「设备」里的内页:手机的设置页自带返回箭头的页头,内页再画一行返回就是两层返回(模拟器实测)。
 * 手机多两样桌面没有的:
 *  · 总开关「让助理用这台手机」—— 电脑本来就挂在设备列表里,手机要人点头才登记成设备(断开 = 从设备列表里删掉);
 *  · 一句实话:被划掉就调不到。保活用 Beta 现成的「后台守着」那条常驻通知,❌ 另做厂商自启动 / 省电白名单引导(owner 10-15)。
 */

const RUNTIME: readonly PhoneRuntimePermission[] = ['calendar', 'contacts', 'location']
const isRuntime = (requirement: PhoneRequirement): requirement is PhoneRuntimePermission =>
  (RUNTIME as readonly string[]).includes(requirement)

const SETTINGS_TARGET: Partial<Record<PhoneRequirement, PhoneSettingsTarget>> = {
  notification_listener: 'notification_listener',
  dnd_access: 'dnd',
}

const LINK_KEYS: Record<PhoneDeviceLink['state'], string> = {
  off: 'devices.phoneActions.linkOff',
  connecting: 'devices.phoneActions.linkConnecting',
  online: 'devices.phoneActions.linkOnline',
  error: 'devices.phoneActions.linkError',
}

export function PhoneDeviceActionsPage() {
  const { t } = useTranslation('settings')
  const { user } = useAuth()
  const userId = user?.id ?? null
  const assistant = useMyAssistant(userId, null)
  const settings = usePhoneDeviceSettings(userId)
  const device = usePhoneDevice()
  const os = device.os
  const [busy, setBusy] = useState<PhoneActionGroup | null>(null)
  const [unreachable, setUnreachable] = useState<string | null>(null)
  const [disconnectFailed, setDisconnectFailed] = useState(false)

  // 进来时、回到前台时(多半刚从系统设置改完权限)重读系统真值。
  useEffect(() => {
    const refresh = () => {
      void refreshPhoneDevice().catch((error: unknown) => log.warn({ error: String(error) }, 'phone os state refresh failed'))
    }
    refresh()
    return platform.subscribeAppActive?.((active) => { if (active) refresh() })
  }, [])

  if (!userId) return null

  const tellPermission = (action: string, enabled: boolean, group?: string) => {
    if (!assistant.agentId && !assistant.loading && !assistant.error) return
    const deviceId = thisPhoneDeviceId(userId) ?? undefined
    void reportAssistantAppChange(assistant.provisionDeviceId ? { rpc: machineRpc(assistant.provisionDeviceId) } : null,
      assistant.agentId ?? undefined, { resource: 'devices', operation: 'edited', section: 'permissions',
        id: deviceId ?? 'phone-permission-settings', deviceId, after: { action, enabled, ...(group ? { group } : {}) } }, userId)
  }

  const openSettings = async (target: PhoneSettingsTarget, name: string) => {
    setUnreachable(null)
    try {
      await nativePhoneActions.openSettings({ target })
    } catch {
      setUnreachable(name)
    }
  }

  const requestRuntime = async (permission: PhoneRuntimePermission, state: PermissionState | undefined) => {
    // 拒过(系统不再弹框)就直达系统里咕咕的设置页;还能弹就弹。
    if (state === 'denied') {
      await openSettings('app', t(`devices.phoneActions.requirements.${permission}`))
      return
    }
    try {
      await nativePhoneActions.requestPermissions({ permissions: [permission] })
    } catch (error) {
      log.warn({ permission, error: String(error) }, 'phone permission request failed')
    }
    await refreshPhoneDevice().catch(() => undefined)
  }

  // 健康:弹 Health Connect 自己那一页(人可以只给其中几类)。拒过两次系统就不再弹 —— 弹完一类都没给,直接带去 Health Connect 里咕咕那一页。
  const requestHealth = async () => {
    try {
      const status = await nativePhoneActions.healthRequest()
      if (status.granted_types.length === 0) await openSettings('health', t('devices.phoneActions.requirements.health_connect'))
    } catch (error) {
      log.warn({ error: String(error) }, 'health connect permission request failed')
      await openSettings('health', t('devices.phoneActions.requirements.health_connect'))
    }
    await refreshPhoneDevice().catch(() => undefined)
  }

  const grant = async (requirement: PhoneRequirement) => {
    if (requirement === 'sms' || requirement === 'recordings' || requirement === 'photos') {
      try {
        const data = await nativePhoneData.request({ group: requirement })
        if (!phoneDataAllowed(requirement, data)) await openSettings('app', t(`devices.phoneActions.requirements.${requirement}`))
      } catch (error) {
        log.warn({ requirement, error: String(error) }, 'phone data permission request failed')
        await openSettings('app', t(`devices.phoneActions.requirements.${requirement}`))
      }
      await refreshPhoneDevice().catch(() => undefined)
      return
    }
    if (isRuntime(requirement)) {
      await requestRuntime(requirement, os?.runtime[requirement])
      return
    }
    if (requirement === 'health_connect') {
      await requestHealth()
      return
    }
    const target = SETTINGS_TARGET[requirement]
    if (target) await openSettings(target, t(`devices.phoneActions.requirements.${requirement}`))
  }

  const toggleMaster = async (on: boolean) => {
    setDisconnectFailed(false)
    setPhoneDeviceEnabled(userId, on)
    tellPermission('phone-device-enabled', on)
    if (on) return
    const { removed } = await disconnectPhoneDevice(userId)
    if (!removed) setDisconnectFailed(true)
  }

  // 「连接」= 打开这一组 + 补系统授权:运行时权限当场弹框,
  // 要去系统设置开的,第一样直接带过去(通知使用权),其余留「去授权」。
  const connect = async (group: PhoneActionGroup) => {
    setBusy(group)
    try {
      setPhoneActionGroup(userId, group, true)
      tellPermission('group-enabled', true, group)
      const missing = missingRequirements(group, os)
      for (const requirement of missing.filter(isRuntime)) await requestRuntime(requirement, os?.runtime[requirement])
      const special = missing.find((requirement) => !isRuntime(requirement))
      if (special) await grant(special)
    } finally {
      setBusy(null)
    }
  }

  const groupRow = (group: PhoneActionGroup) => {
    const connected = settings.groups[group]
    const missing = missingRequirements(group, os)
    const noClock = group === 'alarm' && !!os && !os.special.alarm_app
    const noHealth = group === 'health' && !!os && !os.health.supported
    const noData = ['sms', 'recordings', 'photos'].includes(group) && !!os && !os.data?.supported
    const blocked = connected && (missing.length > 0 || noClock || noHealth || noData)
    const healthGranted = os?.health.granted_types.length ?? 0
    return (
      <SettingsRow
        key={group}
        data-testid={`phone-device-group-${group}`}
        data-connected={connected}
        title={(
          <span className="flex items-center gap-2">
            {t(`devices.deviceActions.group.${group}`)}
            {blocked && <Chip tone="warn">{t('devices.deviceActions.unavailable.os_permission')}</Chip>}
          </span>
        )}
        description={(
          <>
            <div>{t(`devices.phoneActions.groupDescription.${group}`)}</div>
            {connected && missing.length > 0 && (
              <div className="mt-1 flex flex-wrap items-center gap-2" data-testid={`phone-device-missing-${group}`}>
                <span>{t('devices.phoneActions.missing', { names: missing.map((r) => t(`devices.phoneActions.requirements.${r}`)).join('、') })}</span>
                {missing.map((requirement) => (
                  <Button key={requirement} variant="ghost" size="sm" data-testid={`phone-device-grant-${requirement}`} onClick={() => void grant(requirement)}>
                    {missing.length > 1 ? `${t('devices.phoneActions.grant')} · ${t(`devices.phoneActions.requirements.${requirement}`)}` : t('devices.phoneActions.grant')}
                  </Button>
                ))}
              </div>
            )}
            {connected && noData && <div className="mt-1">{t('devices.phoneActions.dataOldApp')}</div>}
            {connected && group === 'photos' && os?.data?.selected && !os.data.images && !os.data.videos && (
              <div className="mt-1">{t('devices.phoneActions.photosSelected')}</div>
            )}
            {connected && group === 'photos' && os?.data?.supported && (
              <Button variant="ghost" size="sm" onClick={() => void (os.data?.images || os.data?.videos ? openSettings('app', t('devices.phoneActions.requirements.photos')) : grant('photos'))}>{t('devices.phoneActions.photosManage')}</Button>
            )}
            {connected && noClock && <div className="mt-1">{t('devices.phoneActions.noClockApp')}</div>}
            {connected && noHealth && (
              <div className="mt-1" data-testid="phone-device-health-unsupported">
                {t(os?.health.old_app ? 'devices.phoneActions.healthOldApp' : 'devices.phoneActions.healthUnsupported')}
              </div>
            )}
            {connected && group === 'health' && healthGranted > 0 && (
              <div className="mt-1 flex flex-wrap items-center gap-2" data-testid="phone-device-health-granted">
                <span>{t('devices.phoneActions.healthPartial', { granted: healthGranted, total: HEALTH_TYPES.length })}</span>
                {os?.health.background_supported && !os.health.background_granted && <span>{t('devices.phoneActions.healthBackgroundHint')}</span>}
                <Button variant="ghost" size="sm" onClick={() => void openSettings('health', t('devices.phoneActions.requirements.health_connect'))}>
                  {t('devices.phoneActions.healthManage')}
                </Button>
              </div>
            )}
            {connected && group === 'location' && os?.runtime.location === 'granted' && !os.special.location_enabled && (
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <span>{t('devices.phoneActions.locationServicesOff')}</span>
                <Button variant="ghost" size="sm" onClick={() => void openSettings('location', t('devices.deviceActions.group.location'))}>
                  {t('devices.phoneActions.openLocationSettings')}
                </Button>
              </div>
            )}
            {connected && group === 'location' && os?.runtime.location === 'granted' && !os.special.background_location && (
              <div className="mt-1 flex flex-wrap items-center gap-2" data-testid="phone-device-background-location">
                <span>{t('devices.phoneActions.backgroundLocationHint')}</span>
                <Button variant="ghost" size="sm" onClick={() => void openSettings('app', t('devices.phoneActions.requirements.location'))}>
                  {t('devices.phoneActions.openAppSettings')}
                </Button>
              </div>
            )}
            {connected && group === 'notifications' && missing.length > 0 && (
              <div className="mt-1 text-[var(--muted-fg)]">{t('devices.phoneActions.restrictedHint')}</div>
            )}
          </>
        )}
        control={connected
          ? (
              <Button variant="secondary" size="sm" onClick={() => { setPhoneActionGroup(userId, group, false); tellPermission('group-enabled', false, group) }} data-testid={`phone-device-disconnect-${group}`}>
                {t('devices.deviceActions.disconnect')}
              </Button>
            )
          : (
              <Button variant="primary" size="sm" disabled={busy !== null} onClick={() => void connect(group)} data-testid={`phone-device-connect-${group}`}>
                {busy === group ? t('devices.deviceActions.connecting') : t('devices.deviceActions.connect')}
              </Button>
            )}
      />
    )
  }

  const connectedGroups = PHONE_ACTION_GROUPS.filter((group) => settings.groups[group])
  const availableGroups = PHONE_ACTION_GROUPS.filter((group) => !settings.groups[group])

  return (
    <SettingsPage data-testid="settings-phone-device-actions">
      <SettingsNote>{t('devices.phoneActions.intro')}</SettingsNote>

      <SettingsGroup
        footer={(
          <>
            {/* 保活用 Beta 现成的「后台守着」(owner 10-15:不另做厂商自启动 / 省电白名单引导),这里只说实话:被划掉就调不到。 */}
            {settings.enabled && <SettingsNote>{t('devices.phoneActions.keepAliveNote')}</SettingsNote>}
            {disconnectFailed && <SettingsNote role="status">{t('devices.phoneActions.disconnectFailed')}</SettingsNote>}
            {unreachable !== null && <SettingsNote role="status">{t('devices.phoneActions.settingsUnreachable', { name: unreachable })}</SettingsNote>}
          </>
        )}
      >
        <SettingsRow
          data-testid="phone-device-master"
          data-link={settings.enabled ? device.link.state : 'off'}
          title={t('devices.phoneActions.master')}
          description={t(LINK_KEYS[settings.enabled ? device.link.state : 'off'])}
          control={<Toggle checked={settings.enabled} onChange={(on) => void toggleMaster(on)} ariaLabel={t('devices.phoneActions.master')} />}
        />
      </SettingsGroup>

      {settings.enabled && (
        <>
          <SettingsNote>{t('devices.phoneActions.thisNote')}</SettingsNote>
          {connectedGroups.length > 0 && <SettingsGroup title={t('devices.deviceActions.connected')}>{connectedGroups.map(groupRow)}</SettingsGroup>}
          {availableGroups.length > 0 && <SettingsGroup title={t('devices.deviceActions.available')}>{availableGroups.map(groupRow)}</SettingsGroup>}

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

/** 与桌面「最近调用」同一种写法:多久前 · 谁调用 · 结果。 */
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
