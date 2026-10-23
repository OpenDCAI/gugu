import { useState } from 'react'
import { Button } from '@/components/ui/Button'
import { SettingsGroup, SettingsNote, SettingsRow } from '@/components/settings/SettingsPrimitives'
import { Bell, Zap } from '@/lib/icons'
import { changeSystemPermission, useSystemPermissionStates } from '@/lib/systemPermissions'
import { platform } from '@/platform'
import type { SystemPermission, SystemPermissionState } from '@/platform/types'
import { PhoneCapabilityGroups } from '../phone-device/PhoneCapabilityGroups'

const RECOMMENDED = ['notifications', 'batteryOptimization'] as const
const STATE_TEXT: Record<SystemPermissionState, string> = { granted: '已开启', prompt: '未开启，可选', blocked: '未开启，去系统设置', unreadable: '查不到，去系统设置' }
const BACKGROUND = {
  notifications: { title: '消息通知', purpose: '任务完成、等待确认时提醒你。', icon: Bell },
  batteryOptimization: { title: '后台运行', purpose: '减少切走或息屏后被系统暂停的情况。', icon: Zap },
}

export function PhoneAgentSetupBackground() {
  const { states, refresh, failed } = useSystemPermissionStates(RECOMMENDED)
  const [pending, setPending] = useState<SystemPermission | null>(null)
  const [error, setError] = useState<string | null>(null)
  const act = async (permission: (typeof RECOMMENDED)[number], state: SystemPermissionState) => {
    if (pending !== null || failed) return
    setPending(permission)
    setError(null)
    try {
      if (!(await changeSystemPermission(permission, state))) setError('没能打开系统设置。可在系统的应用设置里找到咕咕，修改通知或电池限制。')
    } catch {
      setError('授权没有完成。可以继续使用，稍后在「我的 → 权限」里设置。')
    } finally {
      await refresh()
      setPending(null)
    }
  }
  return (
    <>
      <p className="gg-phone-setup-intro">按需要开启消息提醒和后台运行。不给也能使用基础任务，点击按钮才会申请。</p>
      <SettingsGroup title="消息与后台" footer={<SettingsNote>系统关闭咕咕后，仍无法保证继续运行。</SettingsNote>}>
        {RECOMMENDED.filter((permission) => platform.systemPermissions.includes(permission)).map((permission) => {
          const Icon = BACKGROUND[permission].icon
          return (
            <SettingsRow
              key={permission}
              leading={<Icon className="size-5 gg-phone-setting-icon" aria-hidden="true" />}
              title={BACKGROUND[permission].title}
              description={BACKGROUND[permission].purpose}
              control={(
                <Button size="sm" disabled={failed || !states[permission] || pending !== null} data-testid={`phone-setup-${permission}`} onClick={() => void act(permission, states[permission]!)}>
                  {pending === permission ? '正在设置' : states[permission] === 'granted' ? '管理' : '去设置'}
                </Button>
              )}
            >
              <div className="gg-phone-capability-status" role="status">{failed ? '读取系统权限失败' : states[permission] ? STATE_TEXT[states[permission]] : '正在读取系统状态'}</div>
            </SettingsRow>
          )
        })}
      </SettingsGroup>
      {failed && <div className="gg-phone-permission-feedback" role="alert"><SettingsNote tone="danger">读取系统权限失败，也可以稍后设置。</SettingsNote><Button variant="ghost" size="sm" onClick={() => void refresh()}>重试</Button></div>}
      {error && <SettingsNote role="alert" tone="danger">{error}</SettingsNote>}
    </>
  )
}

/** Opening this step only reads state. A category's explicit Connect action opts it in. */
export function PhoneAgentSetupTools({ ownerId }: { ownerId: string }) {
  return (
    <>
      <p className="gg-phone-setup-intro">按用途连接手机能力；全部可选，未连接的能力不能被调用。</p>
      <PhoneCapabilityGroups ownerId={ownerId} context="setup" />
    </>
  )
}
