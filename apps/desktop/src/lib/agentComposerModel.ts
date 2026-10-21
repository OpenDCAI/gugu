import { isCloudAgentMarked } from '@gugu/core/shared/enums/agentTypeModels'
import type { AgentDisplayStatus, AgentType } from '@gugu/core/shared/types/chat'

export function isRetiredCloudAgentChat(input: {
  isAgentChat: boolean
  agentType?: AgentType | null
  chatDeviceId?: string | null
  contactDeviceId?: string | null
}): boolean {
  return input.isAgentChat && isCloudAgentMarked({
    agent_type: input.agentType,
    device_id: input.chatDeviceId ?? input.contactDeviceId,
  })
}

// @@@5856 原来这里还有 composingNewThread / activeThreadRootId 两个入参与它们对应的两个
// placeholder('newThread' / 'threadReply')。thread 视图退役之后,调用点两个值恒为 false/null,
// 两条分支永不可达 —— 守卫的对象没了、守卫还在,就是那种「平时零发作、只在极端路径显形」的死码。
// 话题有自己的 composer(TopicSplitPane),不经过这个模型。
export function agentComposerModel(input: {
  status: AgentDisplayStatus | null
  retiredCloud: boolean
}): {
  disabled: boolean
  disabledReason?: 'retiredCloud' | 'removed'
  placeholder?: 'retiredCloud'
} {
  if (input.retiredCloud) {
    return {
      disabled: true,
      disabledReason: 'retiredCloud',
      placeholder: 'retiredCloud',
    }
  }
  if (input.status === 'removed') {
    return { disabled: true, disabledReason: 'removed' }
  }
  return { disabled: false }
}
