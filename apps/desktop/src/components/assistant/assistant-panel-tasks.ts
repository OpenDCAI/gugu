import { assistantPanelCollection, AssistantPanelError } from '@gugu/core/cloud/assistantPanel'
import type { AssistantPanelFiles } from '@gugu/core/cloud/assistantPanelFiles'
import { parseAgentStatusView } from '@gugu/core/shared/agentStatus'
import { OPEN_ASSISTANT_TASK_CHAT, type AssistantTaskChat } from '@/lib/assistantTaskChat'

export async function readAssistantPanelTasks(panel: AssistantPanelFiles) {
  const snapshot = await panel.snapshot()
  const home = assistantPanelCollection(snapshot,'tasks',panel.deviceId)
  if (home.state !== 'ready') throw new AssistantPanelError(home.state === 'unprepared' ? 'unprepared' : 'collection-unavailable','Task records are unavailable')
  return snapshot.items.filter(row => row.domain === 'tasks' && !row.resource_key.startsWith('__collection__')).map(row => {
    if (typeof row.data.sessionId !== 'string' || typeof row.data.title !== 'string' || !row.device_id) throw new AssistantPanelError('invalid-response','Task address is missing')
    const observedAt = typeof row.data.statusObservedAt === 'string' ? Date.parse(row.data.statusObservedAt) : 0
    return { id: row.data.sessionId,title: row.data.title,harness: typeof row.data.harness === 'string' ? row.data.harness : '',unseen: row.data.unseen === true,deviceId: row.device_id,
      agentId: typeof row.data.agentId === 'string' ? row.data.agentId : null,
      lastInteractedAt: typeof row.data.lastInteractedAt === 'string' ? row.data.lastInteractedAt : null,
      status: row.data.status === 'working' && Date.now() - observedAt > 90_000 ? null : parseAgentStatusView({ status: row.data.status,detail: row.data.statusDetail }),
      assistants: Array.isArray(row.data.assistantSessionIds) ? row.data.assistantSessionIds.filter((id): id is string => typeof id === 'string') : [],
    }
  })
}
export type AssistantPanelTask = Awaited<ReturnType<typeof readAssistantPanelTasks>>[number]
export function openAssistantPanelTask(panel: AssistantPanelFiles, task: AssistantPanelTask) {
  if (!task.agentId) return
  const detail: AssistantTaskChat = { assistantId: panel.assistantId,taskAgentId: task.agentId,
    task: { deviceId: task.deviceId,sessionId: task.id },assistants: task.assistants.map(sessionId => ({ deviceId: panel.deviceId,sessionId })) }
  window.dispatchEvent(new CustomEvent(OPEN_ASSISTANT_TASK_CHAT,{ detail }))
}
