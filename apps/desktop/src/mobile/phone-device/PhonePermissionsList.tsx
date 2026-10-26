import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SettingsGroup, SettingsNote, SettingsRow } from '@/components/settings/SettingsPrimitives'
import { ChevronRight } from '@/lib/icons'
import { changeSystemPermission, systemPermissionRows, useSystemPermissionStates } from '@/lib/systemPermissions'
import { messageForUser } from '@/lib/userFacingError'
import { platform } from '@/platform'
import { PHONE_ACTION_GROUPS, missingRequirements, requirementGranted, type PhoneActionGroup, type PhoneOsState } from './phoneActionCatalog'
import { HEALTH_TYPES } from './nativePhoneActions'
import { connectPhoneActionGroupChoice, readPhoneDeviceSettings, setPhoneActionGroup, usePhoneDeviceSettings } from './phoneDeviceSettings'
import { openPhonePermissionSettings, requestPhoneRequirement } from './phonePermissionActions'
import { readPhoneOsState, refreshPhoneDevice, usePhoneDevice } from './phoneDeviceRuntime'
import { usePhonePermissionReporter } from './usePhonePermissionReporter'

const SYSTEM_NAMES = { notifications: '消息提醒', batteryOptimization: '后台运行', camera: '相机', fileAccess: '文件访问' }

function unsupported(group: PhoneActionGroup, os: PhoneOsState): boolean {
  return group === 'alarm' ? !os.special.alarm_app
    : group === 'health' ? !os.health.supported
      : ['sms', 'recordings', 'photos'].includes(group) && !os.data?.supported
}

/** One management list for phone task consent and its current Android permissions. Mounting only reads. */
export function PhonePermissionsList({ ownerId }: { ownerId: string }) {
  const { t } = useTranslation('settings')
  const settings = usePhoneDeviceSettings(ownerId)
  const report = usePhonePermissionReporter(ownerId)
  const { os } = usePhoneDevice()
  const systemRows = systemPermissionRows()
  const system = useSystemPermissionStates(systemRows.map(row => row.permission))
  const [read, setRead] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const refresh = useCallback(async () => {
    setRead('loading')
    try { await refreshPhoneDevice(); setRead('ready') } catch { setRead('failed') }
  }, [])
  useEffect(() => {
    void refresh()
    return platform.subscribeAppForeground(() => void refresh(), () => setRead('failed'))
  }, [refresh])

  const act = async (key: string, action: () => Promise<void>) => {
    if (busy) return
    setBusy(key)
    setError(null)
    try { await action() } catch (cause) { setError(messageForUser(cause)) }
    finally { await Promise.all([refresh(), system.refresh()]); setBusy(null) }
  }
  const choose = async (group: PhoneActionGroup) => {
    if (!os || read !== 'ready') return
    const selected = settings.enabled && settings.groups[group]
    if (group === 'alarm' && selected) {
      setPhoneActionGroup(ownerId, group, false)
      report('group-enabled', false, group)
      return
    }
    const missing = missingRequirements(group, os)
    // Special access pages must be opened individually. Another tap requests the next missing permission.
    if (missing.length) {
      await requestPhoneRequirement(missing[0], os)
      const latest = await readPhoneOsState()
      if (!requirementGranted(missing[0], latest)) return
    }
    else if (!selected) { /* Existing OS grants need only this explicit local task choice. */ }
    else if (group === 'health') {
      if (os.health.granted_types.length < HEALTH_TYPES.length) await requestPhoneRequirement('health_connect', os)
      else await openPhonePermissionSettings('health')
    } else if (group === 'location' && !os.special.location_enabled) await openPhonePermissionSettings('location')
    else if (group !== 'alarm') await openPhonePermissionSettings(group === 'notifications' ? 'notification_listener' : 'app')
    if (!selected) connectPhoneActionGroupChoice(ownerId, group)
    if (readPhoneDeviceSettings(ownerId).groups[group]) report('group-enabled', true, group)
  }
  const groupStatus = (group: PhoneActionGroup) => {
    if (busy === group) return '正在设置'
    if (read === 'failed') return '未读取'
    if (read !== 'ready' || !os) return '读取中'
    if ((group === 'health' && os.health.old_app) || (['sms', 'recordings', 'photos'].includes(group) && !os.data?.supported)) return '需更新安装包'
    if (unsupported(group, os)) return '此设备不支持'
    if (!settings.enabled || !settings.groups[group]) return '未授权'
    if (group === 'notifications') {
      const count = Number(os.special.notification_listener) + Number(os.special.dnd_access)
      return count === 2 ? '已授权' : count === 0 ? '需系统授权' : `已授权 ${count}/2 项`
    }
    if (missingRequirements(group, os).length) return '需系统授权'
    if (group === 'location' && !os.special.location_enabled) return '定位服务未开启'
    if (group === 'health' && os.health.granted_types.length < HEALTH_TYPES.length) return `已授权 ${os.health.granted_types.length}/${HEALTH_TYPES.length} 项`
    if (group === 'photos' && os.data?.selected && !os.data.images && !os.data.videos) return '已授权所选照片'
    return '已授权'
  }
  const readFailed = read === 'failed' || system.failed
  const feedback = [error, readFailed ? '未读到部分权限状态，点对应项可重新读取。' : null].filter(Boolean).join('；')
  return <SettingsGroup title="本机任务权限" presentation="navigation" data-testid="phone-permissions-list" footer={feedback ? <SettingsNote role="alert" tone="danger">{feedback}</SettingsNote> : undefined}>
    {PHONE_ACTION_GROUPS.map(group => {
      const state = groupStatus(group)
      const title = group === 'notifications' ? t('devices.phoneActions.notificationsAndDnd') : t(`devices.deviceActions.group.${group}`)
      return <SettingsRow key={group} title={title} data-testid={`phone-device-group-${group}`}
        aria-label={`${title}，${state}`} aria-disabled={busy !== null || (!!os && unsupported(group, os))}
        control={<><span className="gg-settings-row-value">{state}</span><ChevronRight className="size-4" aria-hidden="true" /></>}
        onClick={() => {
          if (busy || (os && unsupported(group, os))) return
          if (read !== 'ready' || !os) { void refresh(); return }
          void act(group, () => choose(group))
        }} />
    })}
    {systemRows.map(({ permission }) => {
      const state = system.states[permission]
      const text = busy === permission ? '正在设置' : state === 'granted' ? '已授权' : state === 'unreadable' || system.failed ? '未读取' : state ? '未授权' : '读取中'
      return <SettingsRow key={`system:${permission}`} title={SYSTEM_NAMES[permission]} data-testid={`phone-device-system-${permission}`} aria-disabled={busy !== null}
        control={<><span className="gg-settings-row-value">{text}</span><ChevronRight className="size-4" aria-hidden="true" /></>}
        onClick={() => void act(permission, async () => {
          if (!(await changeSystemPermission(permission, state ?? 'unreadable'))) throw new Error('没能打开系统权限设置，请在系统设置中找到咕咕。')
        })} />
    })}
  </SettingsGroup>
}
