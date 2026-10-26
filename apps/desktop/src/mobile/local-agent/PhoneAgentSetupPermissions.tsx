import { useState } from 'react'
import { Button } from '@/components/ui/Button'
import { SettingsNote } from '@/components/settings/SettingsPrimitives'
import { rendererLogger } from '@/lib/log'
import { messageForUser } from '@/lib/userFacingError'
import { changeSystemPermission } from '@/lib/systemPermissions'
import type { SystemPermission, SystemPermissionState } from '@/platform/types'

const SETTINGS_GUIDANCE = '可在系统的应用设置里找到咕咕，修改对应权限。'
const LABELS: Record<SystemPermission, string> = { notifications: '开启消息通知', batteryOptimization: '允许后台运行', camera: '允许使用相机', fileAccess: '允许文件访问' }
const TITLES: Record<SystemPermission, string> = { notifications: '消息提醒', batteryOptimization: '后台运行', camera: '相机', fileAccess: '文件访问' }
const PURPOSES: Record<SystemPermission, string> = { notifications: '接收任务进展和新消息', batteryOptimization: '切走后，任务照常进行', camera: '扫码加好友、进群', fileAccess: '打开你选择的项目目录' }
const SETTINGS_LABELS: Record<SystemPermission, string> = { notifications: '前往通知设置', batteryOptimization: '前往电池设置', camera: '前往相机设置', fileAccess: '前往文件设置' }

/** Opening and skipping only read state. The primary action explicitly requests permission. */
export function PhoneAgentSetupPermission({ permission, state, onRefresh, summary }: { permission: SystemPermission; state: SystemPermissionState | undefined; onRefresh: () => Promise<void>; summary?: boolean }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const act = async () => {
    if (pending) return
    setPending(true)
    setError(null)
    try {
      if (!(await changeSystemPermission(permission, state ?? 'unreadable'))) setError(`没能打开系统设置。${SETTINGS_GUIDANCE}`)
    } catch (cause) {
      rendererLogger('actions/PhoneAgentSetupPermissions').error({ error: cause }, 'action failed')
      setError(`${messageForUser(cause)} ${SETTINGS_GUIDANCE}`)
    } finally {
      await onRefresh()
      setPending(false)
    }
  }
  const granted = state === 'granted'
  return (
    <div className="gg-phone-setup-field" data-state={granted ? 'granted' : undefined}>
      <div className="gg-phone-setup-field-main">
        <div className="gg-phone-setup-field-copy"><span className="gg-phone-setup-field-title">{TITLES[permission]}</span>{!summary && <span className="gg-phone-setup-field-purpose">{PURPOSES[permission]}</span>}</div>
        {granted || summary ? <span className="gg-phone-setup-field-status" role="status">{granted ? '已开启' : !state || state === 'unreadable' ? '状态未知' : '未开启'}</span> : <Button size="sm" variant="secondary" disabled={pending} data-testid={`phone-setup-${permission}`}
          onClick={() => void act()}>{pending ? '正在设置' : state === 'blocked' ? SETTINGS_LABELS[permission] : LABELS[permission]}</Button>}
      </div>
      {!summary && error && <SettingsNote role="alert" tone="danger">{error}</SettingsNote>}
    </div>
  )
}
