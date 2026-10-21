import type { AgentSettingsPaneProps } from './types'
import { useTranslation } from 'react-i18next'
import { asClass } from './agentSettingsStyles'

// #1228: per-agent contacts 后端未建。原实现把 **owner 的联系人**(排除 agent 自己)冒充
// "该 Agent 的联系人"显示 = 假数据(反 fake 铁律)。设计稿有此面板 → 诚实空态「即将开放」,
// 不再错显 owner 联系人。后端暴露 per-agent contacts API 后接真数据。

export function AgentContactsPane({ agent: _agent }: AgentSettingsPaneProps) {
  const { t } = useTranslation('agents')
  return (
    <div>
      {/* margin-top:0 inline override */}
      <div className={asClass.contactsH2} style={{ marginTop: 0 }}>
        {t('settings.contacts.title')}
      </div>
      {/* #1228 诚实空态：per-agent contacts 后端未建，即将开放（不冒充 owner 联系人） */}
      <div style={{ fontSize: 'var(--font-body)', color: 'var(--faint-fg)', padding: '20px 0', textAlign: 'center' }}>
        {t('settings.contacts.comingSoon')}
      </div>
    </div>
  )
}
