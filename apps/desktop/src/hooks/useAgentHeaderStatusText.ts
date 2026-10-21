import { useTranslation } from 'react-i18next'
import { useAgentDisplayStatus } from './useAgentDisplayStatus'
import { useDevicesStore } from '../store/devicesContext'
import { resolveAgentLocation } from '../lib/agentRunningStatusModels'
import { localizedAgentHeaderStatus } from '../components/chat/chatPresentation'
import { useShownAgentStatus } from '../components/chat/useAgentsOnCloudComputer'

/**
 * 「状态 · 在哪台机器 · 引擎」—— 与聊天标题栏同一个来源、同一种读法(agent 状态表 + 账号名下全部设备行)。
 * 任何要写「这个 agent 在哪跑」的面都读它,❌ 自己再拼一份(那样各面会说不同的机器)。
 */
export function useAgentHeaderStatusText(agentUserId: string | null): string {
  const { t } = useTranslation('messaging')
  const { presence } = useAgentDisplayStatus(agentUserId)
  const { devices } = useDevicesStore()
  const shown = useShownAgentStatus().presentation(agentUserId, presence.presentation) // #7199 宿主闲时收回着 ≠ 不在线
  const payload = presence?.payload ?? null
  const location = resolveAgentLocation(payload?.deviceId, devices)
  // 状态那一句读这个 agent 的完整 presentation(等你批准 / 后台运行中 …),与聊天标题栏同一句。
  return localizedAgentHeaderStatus(shown?.label ?? null, location, payload?.agentType ?? null, t)
}
