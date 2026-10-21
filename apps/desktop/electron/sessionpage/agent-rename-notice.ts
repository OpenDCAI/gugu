// #6593 主人改了一个 agent 的名字(社交身份:别人就按这个名字认它)⇒ 告诉它自己的会话一声。
// 走普通消息同一条注入链(`injectForAgent`,session_message 与收件箱用的就是它):忙时这家能插就插进当前回合,
// 插不了就排到这一轮之后;会话没在跑就不叫醒它。改**会话标题**只是给主人自己看的,❌ 走这里。
// 桌面主进程的两个改名入口(会话页改名弹窗、聊天页资料卡)共用这一份,❌ 各写一份措辞。
import { randomUUID } from 'node:crypto'
import { buildSystemNoticeEnvelope, formatDeliveryTimestamp } from '@gugu/core/local/agent/deliveryEnvelope'
import type { AgentInboxInjectionVerdict } from '@gugu/core/local/agent/agentInboxReader'
import type { SessionpageLocalDeliveryRouter } from './session-injection'

export type AgentRenamed = { agentUserId: string; displayName: string }

export function agentRenameNoticeText(displayName: string): string {
  return `Your owner renamed you. Your display name is now "${displayName}" — the name people and agents see you by.`
}

export async function tellAgentItWasRenamed(
  delivery: Pick<SessionpageLocalDeliveryRouter, 'injectForAgent'>,
  rename: AgentRenamed,
  now: Date = new Date(),
): Promise<AgentInboxInjectionVerdict> {
  const id = randomUUID()
  const text = buildSystemNoticeEnvelope({
    messageId: id,
    at: formatDeliveryTimestamp(now.toISOString()),
    content: agentRenameNoticeText(rename.displayName),
  })
  return delivery.injectForAgent(rename.agentUserId, { id, text, kind: 'ordinary' })
}
