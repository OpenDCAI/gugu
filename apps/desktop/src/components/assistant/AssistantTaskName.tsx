import type { AssistantPanelTask } from './assistant-panel-tasks'
import { useAvatarIdentity } from '@/lib/avatarIdentity'
import { useShownAgentName } from '@/hooks/useShownAgentName'

/** The durable work record has no session creation time; use its executor identity. */
export function AssistantTaskName({ task }: { task: AssistantPanelTask }) {
  const identity = useAvatarIdentity(task.agentId ?? '')
  return useShownAgentName({ name: task.title, agentType: task.harness, createdAt: identity?.created_at ?? undefined })
}
