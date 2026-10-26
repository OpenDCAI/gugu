import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { OtherDeviceConnectors, ThisDeviceConnectors } from '../devices/AssistantDeviceConnectors'
import { SessionSettingsSection } from '../sessionpage/SessionSettingsSection'
import { SegmentedTabs } from '../ui/SegmentedTabs'
import { useAssistantHome } from '../../lib/useAssistantHome'
import { SettingsNote, SettingsPage } from './SettingsPrimitives'
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
  const { contact, home, cloudDeviceId } = useAssistantHome()
  const name = contact?.display_name ?? t('rail')
  const [where, setWhere] = useState<Where>('cloud')
  const cloud = home
    ? <SessionSettingsSection section="connectors" context={{ home, assistantName: name }} />
    : <SettingsNote>{t('machine.reading')}</SettingsNote>

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
