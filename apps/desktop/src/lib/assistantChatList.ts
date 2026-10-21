import type { ChatItem } from '@gugu/core/shared/types/chat'
import type { AssistantShellSnapshot } from './assistantShellBridge'
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'
import { assistantDescendants, isAssistantSession } from '../session/renderer/features/assistant/assistant-lineage'

export type AssistantWorkrooms = { ownerId: string; chatIds: readonly string[]; agentIds: readonly string[] }

/** Only canonical groups belonging exclusively to the assistant's own project. Never match names. */
export function assistantWorkrooms(
  assistantId: string,
  ownerId: string,
  sessions: readonly SessionpageSessionSummary[],
  bindings: readonly { projectId: string; chatId: string }[],
): AssistantWorkrooms {
  const homeProjects = new Set(sessions.filter((s) => isAssistantSession(s, assistantId)).map((s) => s.projectId))
  const chatIds = bindings.filter((binding) => homeProjects.has(binding.projectId)
    && !bindings.some((other) => other.chatId === binding.chatId && !homeProjects.has(other.projectId)))
    .map((binding) => binding.chatId)
  const descendants = assistantDescendants(sessions.map((summary) => ({ summary })), assistantId)
  return { ownerId, chatIds: [...new Set(chatIds)], agentIds: [assistantId, ...descendants.flatMap(({ summary }) => summary.agent ? [summary.agent.userId] : [])] }
}

/** Dedicated assistant DM and internal workrooms; actual collaboration groups remain visible. */
export function isDuplicateAssistantChat(
  chat: Pick<ChatItem, 'id' | 'kind' | 'peer_user_id'> & Pick<Partial<ChatItem>, 'member_user_ids'>,
  shell: AssistantShellSnapshot | null,
  workrooms: AssistantWorkrooms | null = null,
): boolean {
  if (shell?.assistantState !== 'found' || !shell.assistant) return false
  if (chat.kind === 'dm') return chat.peer_user_id === shell.assistant.id && chat.id === shell.chatId
  if (chat.kind !== 'group' || !workrooms?.chatIds.includes(chat.id)) return false
  const members = chat.member_user_ids
  const allowed = new Set([workrooms.ownerId, ...workrooms.agentIds])
  return !!members?.includes(shell.assistant.id) && members.every((id) => allowed.has(id))
}
