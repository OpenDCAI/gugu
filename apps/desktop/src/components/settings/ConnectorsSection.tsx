import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { OtherDeviceConnectors, ThisDeviceConnectors } from '../devices/AssistantDeviceConnectors'
import { SessionSettingsSection } from '../sessionpage/SessionSettingsSection'
import { SegmentedTabs } from '../ui/SegmentedTabs'
import { Button } from '../ui/Button'
import { useAssistantHome } from '../../lib/useAssistantHome'
import { useCloudComputerWake } from '../../hooks/useWakeCloudComputer'
import { LoadingIndicator } from '../../lib/loading/LoadingIndicator'
import { SettingsGroup, SettingsNote, SettingsPage } from './SettingsPrimitives'
import '../../i18n/registerAssistantCatalog'

type Where = 'cloud' | 'device' | 'other'

/**
 * 全局设置「咕咕 → 连接应用」(owner 10-15「连接要分清在哪」+ 10-16 只有一个设置):三段 云端 / 本机 / 其他设备。
 * - 云端 = 有账号的服务,存在咕咕的家里(会话页那一侧画,资源库「集成」的同一套数据;助理 App 的资料页读的也是它);
 * - 本机 / 其他设备 = 数据就在那台设备上,授权也存在那台上(设备页同一批组件)。
 * 助理资料页直接嵌入这个组件:与全局设置共享状态、详情和授权流程。
 */
export function ConnectorsSection() {
  const { t } = useTranslation('assistant')
  const { contact, home, snapshot, cloudDeviceId } = useAssistantHome()
  const name = contact?.display_name ?? t('rail')
  const [where, setWhere] = useState<Where>('cloud')
  // 叫醒挂在这一页上(它开着就一直在),❌ 挂在「正在连接」那一块里:那一块随收回 / 切页签一卸一挂,每挂一次就又叫一次,
  // 页面开着它就永远收不回、一直扣积分。切到别的页签 = 不看云端那一段,不叫;切回来不重叫,收回着就说「连接断了」。
  const presence = snapshot?.state === 'asleep' || snapshot?.state === 'waking' || snapshot?.state === 'awake' ? snapshot.state : null
  const wake = useCloudComputerWake(
    where === 'cloud' && home?.kind !== 'computer' && cloudDeviceId && presence ? { device_id: cloudDeviceId, cloud_computer: presence } : null,
  )

  const cloud = (() => {
    // 住在自己的电脑上:第一段是那台电脑自己的集成,不用叫醒谁(那台关着时资源库自己说读不到)。
    if (home?.kind === 'computer') return <SessionSettingsSection section="connectors" context={{ home, assistantName: name }} />
    if (snapshot?.state === 'awake' && cloudDeviceId)
      return <SessionSettingsSection section="connectors" context={{ cloudDeviceId, assistantName: name }} />
    if (snapshot && cloudDeviceId && (snapshot.state === 'asleep' || snapshot.state === 'waking'))
      return <CloudConnecting wake={wake} name={name} />
    return <SettingsNote>{t('machine.unreachable', { name })}</SettingsNote>
  })()

  return (
    <SettingsPage data-testid="settings-connectors">
      <SettingsNote>{t('connectors.pageSub', { name })}</SettingsNote>
      <div className="ta-connector-tabs">
        <SegmentedTabs<Where>
          variant="underline"
          ariaLabel={t('connectors.title')}
          value={where}
          onChange={setWhere}
          items={[
            { value: 'cloud', label: home?.kind === 'computer' ? t('connectors.where.account') : t('connectors.where.cloud') },
            { value: 'device', label: t('connectors.where.device') },
            { value: 'other', label: t('connectors.where.other') },
          ]}
        />
      </div>
      {where === 'cloud' ? cloud : where === 'device' ? <ThisDeviceConnectors /> : <OtherDeviceConnectors cloudDeviceId={cloudDeviceId} />}
    </SettingsPage>
  )
}

/**
 * 云端那一段要读它家里的集成、它住的云端宿主正收回着:系统自己叫起来,只说「正在连接」(owner 10-17 ❌「在休息 / 叫醒它」);
 * 没叫起来说原因 + 重试。
 */
function CloudConnecting({ wake, name }: { wake: ReturnType<typeof useCloudComputerWake>; name: string }) {
  const { t } = useTranslation('assistant')
  const { t: tc } = useTranslation('common')
  const { issue, dropped, retry } = wake
  if (issue || dropped)
    return (
      <SettingsGroup>
        <div className="gg-settings-empty">
          <SettingsNote>
            <span role={issue ? 'alert' : 'status'} data-testid="settings-connectors-connect-failed" data-kind={issue?.kind ?? 'dropped'}>
              {issue ? <>{t('machine.connectFailed', { name })}{tc(`cloudComputer.reason.${issue.kind}`)}</> : t('machine.dropped', { name })}
            </span>
          </SettingsNote>
          <Button size="sm" onClick={retry} data-testid="settings-connectors-retry">{issue ? t('machine.retry') : t('machine.reconnect')}</Button>
        </div>
      </SettingsGroup>
    )
  return (
    <SettingsNote>
      <span className="inline-flex items-center gap-2" data-testid="settings-connectors-connecting">
        <LoadingIndicator size="inline" />
        {t('machine.connecting', { name })}
      </span>
    </SettingsNote>
  )
}
