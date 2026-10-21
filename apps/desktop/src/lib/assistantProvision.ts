import type { AgentProvision } from '@gugu/core/shared/types/agentProvision'

/**
 * #7199 谁是这个人的「个人助理」(owner:「它是一个个人级别的 agent……只有一个身份」):
 * 开通的最后一步把它建出来时打的标记 —— `identity.agent_provisions` 里 `member_key='assistant'` 的那一行,`agent_user_id` 就是它。
 * 会员一键领取由管家在云上建、非会员在自己的电脑上建(owner 10-16「我们不强制用户使用云电脑」),两条走的是同一条链、同一个标记。
 * 认法 = 这个标记,❌ 按名字(它能改名)、❌ 按「住在云电脑上的第一个 agent」(人也能在云电脑上建别的 agent)、
 * ❌ 按住在哪台(它会搬家:会员到期搬回电脑、开了会员搬上云)。
 */
export type AssistantProvisionRow = Pick<AgentProvision, 'agent_user_id' | 'device_id' | 'member_key' | 'phase' | 'created_at'>

export type AssistantPick = {
  agentId: string
  /** 建它(或最近一次把它搬过去)的那台。它此刻住哪以通讯录里它的 `device_id` 为准(搬家落定时改的是那一列),这一格是读不到通讯录时的退路。 */
  deviceId: string
}

const GONE_PHASES = new Set<AgentProvision['phase']>(['failed', 'cancelling', 'cancelled'])

/** 这个人的那一位:标记对、已经有身份、没被撤回;不止一行(重开过云电脑、搬过家)时取最近建的。 */
export function pickAssistant(rows: readonly AssistantProvisionRow[]): AssistantPick | null {
  const live = rows.filter((row) => row.member_key === 'assistant' && row.agent_user_id && !GONE_PHASES.has(row.phase))
  live.sort((a, b) => b.created_at.localeCompare(a.created_at))
  const top = live[0]
  return top?.agent_user_id ? { agentId: top.agent_user_id, deviceId: top.device_id } : null
}
