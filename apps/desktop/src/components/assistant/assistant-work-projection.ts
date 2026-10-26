import type { AssistantWorkEvent,AssistantWorkTask } from '@gugu/core/cloud/assistantWork'
import { withSessionAttachments,type SessionAttachmentRef } from '@gugu/core/cloud/sessionAttachments'
import type { AgentStatusView } from '@gugu/core/shared/agentStatus'
import type { TaskExchange } from '../../session/shared/core/sessions/task-collaboration'

/** A durable task survives an executor directory entry or its device going away. */
export function assistantWorkTasks(records: readonly AssistantWorkTask[]) {
  return records.flatMap(work => work.executors.map(executor => ({
    key: `${work.work_id}:${executor.session_id}`,workId: work.work_id,id: executor.session_id,title: work.title,
    deviceId: executor.device_id,agentId: executor.agent_user_id ?? null,lastInteractedAt: work.updated_at,
    outcome: work.executor_outcomes[executor.session_id]?.status ?? work.outcome,
    assistants: [{ deviceId: work.coordinator_device_id,sessionId: work.coordinator_session_id }],
  })))
}

/** Task outcome and a live agent reading are independent facts. Idle never completes a task. */
export function assistantWorkStatus(outcome: string,reading: AgentStatusView | null): AgentStatusView | null {
  if (outcome === 'completed') return { status: 'idle',detail: 'done' }
  if (outcome === 'failed') return { status: 'error',detail: null }
  if (outcome === 'cancelled') return null
  return reading?.status === 'idle' ? { status:'idle',detail:'plain' } : reading
}

export function assistantWorkExchanges(events: readonly AssistantWorkEvent[],workId: string): Array<TaskExchange & { sourceMessageId: string | null }> {
  return events.filter(event => event.work_id === workId && event.source_available && event.content !== null).map((event,index) => {
    const files = event.attachment_refs.filter((ref): ref is SessionAttachmentRef => 'attachment_id' in ref)
    return { id: event.message_id,position: index,sourceMessageId: event.source_message_id,
      fromSessionId: event.from_session_id,toSessionId: event.to_session_id,
      content: withSessionAttachments(event.content!,files),createdAt: event.platform_received_at }
  })
}
