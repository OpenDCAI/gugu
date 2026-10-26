import { useCallback, useEffect, useState } from 'react'
import { SettingsGroup, SettingsNote, SettingsRow } from '@/components/settings/SettingsPrimitives'
import { ChevronRight } from '@/lib/icons'
import { changeSystemPermission, systemPermissionRows, useSystemPermissionStates } from '@/lib/systemPermissions'
import { messageForUser } from '@/lib/userFacingError'
import { platform } from '@/platform'
import { requirementGranted, type PhoneActionGroup, type PhoneOsState } from './phoneActionCatalog'
import { HEALTH_TYPES } from './nativePhoneActions'
import { connectPhoneActionGroupChoice, setPhoneActionGroup, usePhoneDeviceSettings } from './phoneDeviceSettings'
import { openPhonePermissionSettings, requestPhoneRequirement } from './phonePermissionActions'
import { readPhoneOsState, refreshPhoneDevice, usePhoneDevice } from './phoneDeviceRuntime'
import { PHONE_PERMISSION_ROWS, type PhonePermissionRow } from './phonePermissionRows'
import { usePhonePermissionReporter } from './usePhonePermissionReporter'

const SYSTEM_NAMES = { notifications: '通知', batteryOptimization: '后台运行', camera: '相机', fileAccess: '文件访问' }
const SYSTEM_PURPOSES = { notifications: '用来接收任务进展和聊天新消息。', batteryOptimization: '用来让这台手机上的任务 Agent 在你切走后继续处理任务。', camera: '用来扫码加好友、进群。', fileAccess: '用来打开你选择的项目目录。' }
function unsupported(group: PhoneActionGroup, os: PhoneOsState): boolean {
  return group === 'alarm' ? !os.special.alarm_app : group === 'health' ? !os.health.supported : ['sms', 'recordings', 'photos'].includes(group) && !os.data?.supported
}

/** The sole phone permission manager. Rendering, visiting and foreground refresh only read Android state. */
export function PhonePermissionsList({ ownerId }: { ownerId: string }) {
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
    setBusy(key); setError(null)
    try { await action() } catch (cause) { setError(messageForUser(cause)) }
    finally { await Promise.all([refresh(), system.refresh()]); setBusy(null) }
  }
  const choose = async ({ group, requirement }: PhonePermissionRow) => {
    if (!os || read !== 'ready') return
    const selected = settings.enabled && settings.groups[group]
    if (group === 'alarm' && selected) {
      setPhoneActionGroup(ownerId, group, false); report('group-enabled', false, group); return
    }
    if (!requirementGranted(requirement, os)) {
      await requestPhoneRequirement(requirement, os)
      if (!requirementGranted(requirement, await readPhoneOsState())) return
    } else if (group === 'location' && !os.special.location_enabled) await openPhonePermissionSettings('location')
    else if (selected) {
      if (group === 'health' && (os.health.granted_types.length < HEALTH_TYPES.length || (os.health.background_supported && !os.health.background_granted))) await requestPhoneRequirement('health_connect', os)
      else if (group === 'photos' && (!os.data?.images || !os.data.videos)) await requestPhoneRequirement('photos', os)
      else if (group !== 'alarm') await openPhonePermissionSettings(requirement === 'notification_listener' ? 'notification_listener' : requirement === 'dnd_access' ? 'dnd' : group === 'health' ? 'health' : 'app')
    }
    if (!selected) connectPhoneActionGroupChoice(ownerId, group)
    report('group-enabled', true, group)
  }
  const status = ({ id, group, requirement }: PhonePermissionRow) => {
    if (busy === id) return '正在设置'
    if (read === 'failed') return '未读取'
    if (read !== 'ready' || !os) return '读取中'
    if ((group === 'health' && os.health.old_app) || (['sms', 'recordings', 'photos'].includes(group) && !os.data?.supported)) return '需更新安装包'
    if (unsupported(group, os)) return '此设备不支持'
    if (!requirementGranted(requirement, os)) return '未授权'
    const selected = settings.enabled && settings.groups[group]
    if (group === 'alarm') return selected ? '已启用' : '未启用'
    if (group === 'location' && !os.special.location_enabled) return '定位服务未开启'
    if (!selected) return '已授权 · 待启用'
    if (group === 'health' && os.health.granted_types.length < HEALTH_TYPES.length) return `已授权 ${os.health.granted_types.length}/${HEALTH_TYPES.length} 项`
    if (group === 'photos' && (!os.data?.images || !os.data.videos)) return '部分授权'
    return '已授权'
  }
  const feedback = [error, read === 'failed' || system.failed ? '未读到部分权限状态，点对应项可重新读取。' : null].filter(Boolean).join('；')
  const trailing = (text: string) => <><span className="gg-settings-row-value">{text}</span><ChevronRight className="size-4" aria-hidden="true" /></>
  return <SettingsGroup presentation="navigation" data-testid="phone-permissions-list" footer={feedback ? <SettingsNote role="alert" tone="danger">{feedback}</SettingsNote> : undefined}>
    {systemRows.map(({ permission }) => {
      const state = system.states[permission]
      const text = busy === `system:${permission}` ? '正在设置' : state === 'granted' ? '已开启' : state === 'unreadable' || system.failed ? '未读取' : state ? '未开启' : '读取中'
      return <SettingsRow key={`system:${permission}`} title={SYSTEM_NAMES[permission]} description={SYSTEM_PURPOSES[permission]} data-testid={`phone-device-system-${permission}`} aria-disabled={busy !== null}
        control={trailing(text)} onClick={() => void act(`system:${permission}`, async () => {
          if (!(await changeSystemPermission(permission, state ?? 'unreadable'))) throw new Error('没能打开系统权限设置，请在系统设置中找到咕咕。')
        })} />
    })}
    {PHONE_PERMISSION_ROWS.map(row => <SettingsRow key={row.id} title={row.title} description={row.purpose} data-testid={`phone-device-group-${row.id}`}
      aria-label={`${row.title}，${status(row)}`} aria-disabled={busy !== null || (!!os && unsupported(row.group, os))} control={trailing(status(row))}
      onClick={() => {
        if (busy || (os && unsupported(row.group, os))) return
        if (read !== 'ready' || !os) { void refresh(); return }
        void act(row.id, () => choose(row))
      }} />)}
  </SettingsGroup>
}
