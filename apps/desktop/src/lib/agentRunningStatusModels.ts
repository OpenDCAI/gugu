import { machineKeyOf } from '@gugu/core/shared/deviceMachines'
import type { AgentLocation } from '@gugu/core/shared/ui/agentHeaderStatusModels'
import { isTransientAgentConversationStatus } from '@gugu/core/shared/ui/agentConversationStatusModels'
import { isAssistantHome } from './assistantHome'
import type {
  AgentConversationActivity,
  AgentDisplayStatus,
  Device,
} from '@gugu/core/shared/types/chat'

export function resolveAgentLocation(
  deviceId: string | null | undefined,
  devices: readonly Device[],
): AgentLocation | null {
  if (!deviceId) return null
  if (deviceId.startsWith('cloud:')) return 'cloud'

  const device = devices.find((candidate) => candidate.device_id === deviceId)
  if (!device) return null
  // #7199 个人助理住的那台:任何时候都不说它在哪、❌ 读那台的机器名(owner 10-15「用户只知道个人助理 Agent，
  // 甚至不需要知道它生活在哪儿」)。那台自己随心跳报的标记设备行一出现就在,不等管家。
  if (isAssistantHome(device, null)) return null
  // 同一台电脑的几条设备行(正式版/测试版)都是「本机」—— 与通讯录分段同一个判据(core machineKeyOf)。
  const current = devices.find((candidate) => candidate.is_current_device)
  if (device.is_current_device || (current && machineKeyOf(current) === machineKeyOf(device))) {
    return 'local'
  }

  const deviceName = device.label.trim()
  return deviceName ? { kind: 'remote', deviceName } : null
}

/**
 * 「这个 agent 在哪台机器上」的那个词。聊天标题栏、会话列表标签、成员面板、Agent 设置头部都读它,
 * 各面说同一台机器、同一个叫法(本机 / 咕咕云 / 设备名)。纯函数。
 */
export function agentLocationText(
  location: AgentLocation | null,
  t: (key: 'chatArea.agentLocation.local' | 'chatArea.agentLocation.cloud') => string,
): string | null {
  if (location === 'local') return t('chatArea.agentLocation.local')
  if (location === 'cloud') return t('chatArea.agentLocation.cloud')
  return location?.deviceName.trim() || null
}

export function resolveAgentRunningDisplayName(
  preferredName: string | null | undefined,
  fallbackName?: string | null,
): string {
  return preferredName?.trim() || fallbackName?.trim() || 'Agent'
}

// 群 thread panel 的「运行中」占位指示器要画谁。群没有单一权威对象,所以按「任一成员在干活即在干活」
// 挑第一个在跑的成员来画身份 —— 状态仍来自那张按 agentId 的表,❌ 这里不判断谁在跑,只挑一个来画。
// 纯函数放在这里而不是会话组件里:god file 冻结之外,更重要的是它可被单测直接判。
export function resolveGroupRunningIndicator(input: {
  chatId: string | null
  threadRootId: string | null
  agentIds: readonly string[]
  statuses: Readonly<Record<string, AgentDisplayStatus>>
  identities: Readonly<Record<string, { display_name: string; avatar: string | null } | undefined>>
}): AgentConversationActivity | null {
  if (!input.chatId) return null
  const workingId = input.agentIds.find((id) => isTransientAgentConversationStatus(input.statuses[id] ?? 'offline'))
  if (!workingId) return null
  return {
    agentId: workingId,
    chatId: input.chatId,
    threadRootId: input.threadRootId,
    displayName: input.identities[workingId]?.display_name ?? '',
    avatar: input.identities[workingId]?.avatar ?? null,
    startedAt: '',
    // 群里被选中的这位 display 态必是 working(isTransient 只认它)⇒ 它的回合活动就是 running。
    status: 'running',
  }
}
