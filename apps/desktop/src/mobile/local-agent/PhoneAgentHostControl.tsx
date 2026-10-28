import { useState } from 'react'
import { Button } from '@/components/ui/Button'
import { SettingsGroup, SettingsNote, SettingsRow } from '@/components/settings/SettingsPrimitives'
import { restartPhoneAgentHost, stopPhoneAgentHost, usePhoneDevice } from '../phone-device/phoneDeviceRuntime'
import { setPhoneAgentHostEnabled, usePhoneDeviceSettings } from '../phone-device/phoneDeviceSettings'
import { phoneAgentAvailable } from './nativeAgent'
import '../phone-device/phone-device.css'

/** Hosting is a device setting; Agent creation and conversations stay in their existing flows. */
export function PhoneAgentHostControl({ ownerId, setup, summary }: { ownerId: string; setup?: boolean; summary?: boolean }) {
  const phone = usePhoneDevice()
  const settings = usePhoneDeviceSettings(ownerId)
  const [changing, setChanging] = useState<'stop' | 'restart' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const host = phone.host?.ownerId === ownerId ? phone.host : null
  const ready = settings.hostEnabled && host?.ready && host.status === 'ready'
  const failed = settings.hostEnabled && (host?.status === 'failed' || host?.status === 'interrupted' || host?.status === 'stopped' || phone.link.state === 'error')
  const hostError = !settings.hostEnabled ? null
    : host?.error ?? (host?.status === 'failed' ? host.message : undefined)
      ?? (phone.link.state === 'error' ? phone.link.message : undefined)
      ?? (host?.status === 'interrupted' ? '上次任务已中断，可在原任务里继续。' : null)
  const statusText = changing === 'stop' ? '正在停止手机 Agent'
    : changing === 'restart' ? '正在启动'
      : error ? '操作未完成'
        : !settings.hostEnabled ? (host?.status === 'stopped' ? '手机 Agent 已停止' : '未启用手机 Agent')
          : ready ? '可处理任务'
            : host?.status === 'interrupted' ? '手机 Agent 已中断'
              : host?.status === 'stopped' ? '手机 Agent 已停止'
                : failed ? '手机 Agent 启动失败' : '正在启动手机 Agent'

  const changeHost = async (kind: 'stop' | 'restart') => {
    if (changing) return
    setChanging(kind)
    setError(null)
    try {
      if (kind === 'stop') await stopPhoneAgentHost(ownerId)
      else await restartPhoneAgentHost(ownerId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setChanging(null)
    }
  }

  if (!phoneAgentAvailable()) return null

  if (summary) return (
    <div className="gg-phone-setup-field gg-phone-setup-host-summary">
      <div className="gg-phone-setup-field-main">
        <span className="gg-phone-setup-field-title">手机 Agent</span>
        <span className="gg-phone-capability-status" role="status">{statusText}</span>
      </div>
    </div>
  )

  if (setup) return (
    <div className="gg-phone-setup-field" data-state={ready ? 'granted' : undefined}>
      <div className="gg-phone-setup-field-main">
        <div className="gg-phone-setup-field-copy">
          <span className="gg-phone-setup-field-title">手机 Agent</span>
          <span className="gg-phone-setup-field-purpose">在这台手机上处理任务</span>
          {settings.hostEnabled && <span className="gg-phone-host-status" role="status">{statusText}</span>}
        </div>
        <Button size="sm" disabled={!!changing} data-testid="phone-setup-enable-host" onClick={() => {
          if (failed) void changeHost('restart')
          else if (settings.hostEnabled) void changeHost('stop')
          else { setError(null); setPhoneAgentHostEnabled(ownerId, true) }
        }}>{changing ? '正在设置' : failed ? '重新启动' : settings.hostEnabled ? '停止运行' : '启用 Agent'}</Button>
      </div>
      {(error || hostError) && <SettingsNote tone="danger" role="alert">{error ?? hostError}</SettingsNote>}
    </div>
  )

  return (
    <SettingsGroup
      className="gg-phone-host-control"
      data-testid="phone-agent-host-settings"
      footer={error || hostError ? <SettingsNote tone="danger" role="alert">{error ?? hostError}</SettingsNote> : undefined}
    >
      <SettingsRow
        title="手机任务"
        stack
        control={(
          <div className="flex flex-wrap items-center gap-2">
            {settings.hostEnabled || changing
              ? <Button size="sm" disabled={!!changing} onClick={() => void changeHost('stop')}>停止手机 Agent</Button>
              : <Button size="sm" variant="primary" onClick={() => { setError(null); setPhoneAgentHostEnabled(ownerId, true) }}>启用手机 Agent</Button>}
            {failed && <Button size="sm" disabled={!!changing} onClick={() => void changeHost('restart')}>重新启动</Button>}
          </div>
        )}
      >
        <div className="gg-phone-host-status" data-ready={!!ready && !changing && !error} role="status" data-testid="phone-host-status">{statusText}</div>
      </SettingsRow>
    </SettingsGroup>
  )
}
