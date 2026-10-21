import type { AgentStatusLabel } from '@gugu/core/shared/agentStatusPresentation'
import type { AgentDisplayStatus } from '@gugu/core/shared/types/chat'
import { labelOfDisplayStatus } from '@gugu/core/shared/ui/agentConversationStatusModels'
import { i18n } from '@/i18n'

/**
 * 状态那一句只有一张表:`common` 命名空间的 `agentStatus.*`(与会话页 `messages.ts`、手机同一份措辞,parity 测试钉住)。
 * 聊天侧任何一面、任何命名空间的组件都经这里取,❌ 在自己的命名空间里另存一份「运行中 / 在线」。
 * 调用方所在组件自己订阅语言(useTranslation),换语言时照常重渲,这里读到的就是当前语言。
 */
export function agentStatusText(label: AgentStatusLabel): string {
  return i18n.t(`agentStatus.${label}`, { ns: 'common' })
}

/** 粗分类的那一句(群汇总、多个 agent 并成一格时用;单个 agent 读 presentation 的 `label`)。 */
export function agentDisplayStatusText(status: AgentDisplayStatus): string {
  return agentStatusText(labelOfDisplayStatus(status))
}
