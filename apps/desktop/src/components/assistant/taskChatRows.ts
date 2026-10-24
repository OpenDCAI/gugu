import type { MessageItem } from '@gugu/core/shared/types/chat'
import { visibleDeliveryMessages } from '@gugu/core/shared/ui/systemNotice'
import type { AssistantTaskChat } from '../../lib/assistantTaskChat'
import type { TaskExchange } from '../../session/shared/core/sessions/task-collaboration'
import type { ChatListRowItem } from '../chat/MessageList'

/** Keep the IM history window intact and progressively reveal older collaboration, rather than mounting all of it. */
export function taskChatWindow(rows: ChatListRowItem[], count: number): { rows: ChatListRowItem[]; earlier: number } {
  const collaboration = rows.filter((row) => row.type === 'task-exchange')
  const earlier = Math.max(0, collaboration.length - count)
  if (earlier === 0) return { rows, earlier }
  const visible = new Set(collaboration.slice(earlier).map((row) => row.message.id))
  return { rows: rows.filter((row) => row.type === 'message' || visible.has(row.message.id)), earlier }
}

export function taskChatRows(messages: readonly MessageItem[], exchanges: readonly TaskExchange[], task: AssistantTaskChat | null, query: string): ChatListRowItem[] {
  const rows: ChatListRowItem[] = visibleDeliveryMessages(messages).map((message) => ({ type: 'message', message }))
  if (!task) return rows
  const seen = new Set<string>()
  for (const entry of exchanges) {
    const fromAssistant = task.assistants.some((assistant) => assistant.sessionId === entry.fromSessionId)
    const toAssistant = task.assistants.some((assistant) => assistant.sessionId === entry.toSessionId)
    if (!(fromAssistant && entry.toSessionId === task.task.sessionId) && !(toAssistant && entry.fromSessionId === task.task.sessionId)) continue
    if (seen.has(entry.id) || (query && !entry.content.toLowerCase().includes(query.toLowerCase()))) continue
    seen.add(entry.id)
    rows.push({
      type: 'task-exchange', recipientUserId: fromAssistant ? task.taskAgentId : task.assistantId,
      message: {
        id: `session-direct:${entry.id}`, chat_id: messages[0]?.chat_id ?? '', seq: -1,
        sender_user_id: fromAssistant ? task.assistantId : task.taskAgentId, to_user_ids: null,
        content: entry.content, content_type: 'text', created_at: entry.createdAt,
        reply_to_message_id: null, retracted_at: null, reactions: [], is_mine: fromAssistant, delivered: false, delivery_status: null,
      },
    })
  }
  return rows.sort((a, b) => Date.parse(a.message.created_at) - Date.parse(b.message.created_at)
    || (a.type === 'message' && b.type === 'message' ? a.message.seq - b.message.seq : a.message.id.localeCompare(b.message.id)))
}
