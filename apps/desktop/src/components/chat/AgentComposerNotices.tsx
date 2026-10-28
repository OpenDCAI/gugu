import { useTranslation } from 'react-i18next'
import { useContactsStore } from '@/store/contactsContext'
import { useDevicesStore } from '@/store/devicesContext'
import { ComposerNotice } from './ComposerNotice'
import { useRefreshCloudComputerFor } from './useAgentsOnCloudComputer'

// agent 会话 composer 上方的通知聚合区(仅 agent 会话渲染)。
// disabledReason 非空即渲染不可发送说明（注销或已退役的云 Agent）。
// #7199 owner 10-17:Agent 没有休息 / 睡眠这回事,全天收消息、处理、回复 —— 它住的云端宿主闲时收回、有事自己醒,
// 那是后台资源的事,❌ 在这里说「X 在休息，发消息会叫醒它」/「正在醒来」。真有投递 / 连接故障由各自那一处如实说。
// 它开浏览器干活:聊天页 ❌ 浮浏览器小窗(owner 10-28,只留 Browser Use App)。
export function AgentComposerNotices({
  disabledReason,
  agentUserId = null,
  agentName = '',
}: {
  disabledReason: string | null
  agentUserId?: string | null
  /** 聊天对象的名字(如「个人助理」):浏览器小窗说「个人助理正在浏览」。 */
  agentName?: string
}) {
  const { t } = useTranslation('messaging')
  const { t: tc } = useTranslation('common')
  const { contacts } = useContactsStore()
  const { cloudComputer } = useDevicesStore()
  const agent = contacts.find((contact) => contact.id === agentUserId)
  const name = agent?.display_name ?? ''
  useRefreshCloudComputerFor(agentUserId)
  // 它住的云电脑叫醒被拒(积分用完 / 会员到期):这是真故障,照实说为什么上不了线(❌ 当它收回着什么都不说)。
  const refused = cloudComputer?.wakeRefused && agent?.device_id === cloudComputer.wakeRefused.deviceId ? cloudComputer.wakeRefused : null
  return (
    <>
      {disabledReason ? <ComposerNotice><span>{disabledReason}</span></ComposerNotice> : null}
      {!disabledReason && refused ? (
        <ComposerNotice>
          <span role="alert" data-testid="agent-wake-refused" data-kind={refused.kind}>
            {t('agent.wakeRefused', { name: agentName || name })}
            {tc(`cloudComputer.reason.${refused.kind}`)}
          </span>
        </ComposerNotice>
      ) : null}
    </>
  )
}
