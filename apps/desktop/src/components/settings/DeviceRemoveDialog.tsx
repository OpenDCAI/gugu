import { useTranslation } from 'react-i18next'
import type { Device } from '@gugu/core/shared/types/chat'
import { boundAgentsBlock, type BoundAgentsState, type DeviceRowModel } from '../../lib/deviceRowModel'
import { Button } from '../ui/Button'
import { Sheet } from '../ui/Sheet'

// #6264「移除这台机器」的确认页。移除是「这个账号不再用这台机器」,所以要按机器的种类说清后果
// (移除语义写在确认页上):
//  · 咕咕 server:那台机器上你的账号被退出登录、从列表消失;别人不受影响;离线时照样生效、它回来就退出。
//  · 别的电脑:只是从列表消失,那台电脑再打开咕咕会回来 —— 如实说,❌ 假装它被踢下线了。
// 有你的智能体在上面时,必须显式勾选「连同它们一起删除」才放行(agent 无法脱离机器存在)。

const body = 'text-[length:var(--font-body)] leading-[1.5]'

/** 这台机器上你的智能体:列出来 + 一个「我确认连同删除」的勾。移除与卸载两个确认页共用。 */
export function BoundAgentsConfirm({
  state,
  onCascadeChange,
}: {
  state: BoundAgentsState
  onCascadeChange: (value: boolean) => void
}) {
  const { t } = useTranslation('settings')
  if (state.loading) return <div className={`${body} text-[var(--muted-fg)]`}>{t('devices.checkingAgents')}</div>
  if (state.agents.length === 0) return null
  return (
    <div className="flex flex-col gap-2">
      <div className={`${body} text-[var(--muted-fg)]`}>{t('devices.boundAgents', { count: state.agents.length })}</div>
      {/* 对话框里的清单:密度面板,❌ 再画一圈框(框套框)。 */}
      <div className="flex max-h-40 flex-col gap-[5px] overflow-y-auto rounded-[var(--radius-document)] bg-foreground/[0.025] px-[10px] py-2 dark:bg-foreground/[0.04]">
        {state.agents.map((agent) => (
          <div key={agent.id} className={`${body} truncate text-[var(--fg)]`}>{agent.display_name}</div>
        ))}
      </div>
      <label className={`${body} flex cursor-pointer items-start gap-2 text-[var(--fg)]`}>
        <input
          type="checkbox"
          checked={state.cascadeChecked}
          onChange={(e) => onCascadeChange(e.target.checked)}
          className="mt-[2px]"
        />
        <span>{t('devices.cascadeConfirm', { count: state.agents.length })}</span>
      </label>
    </div>
  )
}

export function DeviceRemoveDialog({
  device,
  model,
  agents,
  onCascadeChange,
  removing,
  failed,
  onCancel,
  onConfirm,
}: {
  device: Device
  model: DeviceRowModel
  agents: BoundAgentsState
  onCascadeChange: (value: boolean) => void
  removing: boolean
  failed: string
  onCancel: () => void
  onConfirm: () => void
}) {
  const { t } = useTranslation('settings')
  const consequence =
    model.kind === 'server' ? t('devices.remove.server')
      : model.kind === 'cloud' ? t('devices.remove.cloud')
        : t('devices.remove.desktop')
  return (
    <Sheet
      onClose={onCancel}
      desktopWidth="400px"
      desktopMaxHeight="80vh"
      mobileFitContent
      ariaLabel={t('devices.remove.label', { name: device.label })}
      testId="settings-device-remove-dialog"
      zIndex="var(--z-settings-modal)"
    >
      <div className="flex flex-col gap-3 overflow-y-auto p-[18px]">
        <div className="text-[length:var(--font-title)] font-semibold text-[var(--fg)]">{t('devices.remove.title', { name: device.label })}</div>
        {device.tier && <div className={body}>{t('devices.configurations')} · {device.tier}</div>}
        <div className={`${body} text-[var(--muted-fg)]`}>{consequence}</div>
        {model.kind === 'server' && !device.is_online && (
          <div className={`${body} text-[var(--muted-fg)]`}>{t('devices.remove.serverOffline')}</div>
        )}
        {model.kind === 'server' && model.connection.via === 'ssh' && (
          <div className={`${body} text-[var(--muted-fg)]`}>{t('devices.remove.sshNote')}</div>
        )}
        <BoundAgentsConfirm state={agents} onCascadeChange={onCascadeChange} />
        {failed && <div className={`${body} text-[var(--danger)]`}>{failed}</div>}
        <div className="flex justify-end gap-2">
          <Button size="sm" onClick={onCancel}>{t('devices.cancel')}</Button>
          <Button size="sm" variant="danger" disabled={removing || boundAgentsBlock(agents)} onClick={onConfirm}>
            {removing ? t('devices.remove.removing') : t('devices.remove.confirm')}
          </Button>
        </div>
      </div>
    </Sheet>
  )
}
