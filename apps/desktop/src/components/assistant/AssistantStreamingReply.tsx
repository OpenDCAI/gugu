import type { SessionLiveReply } from '@gugu/session-core/session-record/contract'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { MessageBubble } from '../chat/MessageBubble'
import { useChatStore } from '../../store/chatContext'
import { useAuth } from '../../store/auth'
import { useMobileShell } from '../../hooks/useMobileShell'
import { useAssistantConversationProgress } from './assistantConversationProgressContext'
import { visibleReplyQuoteIds } from '../chat/replyQuoteVisibility'

const inactive = () => undefined

/** The preview and persisted IM reply use the exact same bubble, quote and width contract. */
export function AssistantStreamingReply({ activity }: {
  activity: Extract<SessionLiveReply['activity'], { phase: 'draft' }>
}) {
  const { activeChat, messages } = useChatStore('activeChat', 'messages')
  const { user } = useAuth()
  const mobile = useMobileShell()
  const progress = useAssistantConversationProgress()
  const source = activity.replyToMessageId ? messages.find(message => message.id === activity.replyToMessageId) : null
  const input = messages.find(message => message.id === progress?.live?.sourceMessageId.replace(/^msg:/, ''))
  if (!activeChat) return null
  const preview: MessageItem = {
    id: `live-reply:${activity.id}`, chat_id: activeChat.id, seq: -1,
    sender_user_id: activeChat.peer_user_id ?? null, to_user_ids: null,
    content: activity.text, content_type: 'text', created_at: source?.created_at ?? input?.created_at ?? new Date(0).toISOString(),
    reply_to_message_id: source?.id ?? null, reply_to_sender_user_id: source?.sender_user_id,
    reply_to_content: source?.content, retracted_at: null, reactions: [],
    is_mine: false, delivered: false, delivery_status: null,
  }
  const owner = user ? { id: user.id, displayName: user.nickname, avatar: user.avatarUrl ?? null, email: null, type: 'human' as const, role: 'member' as const } : null
  return <div data-testid="assistant-streaming-reply" inert>
    <MessageBubble msg={preview} isAgent hideAvatar hideTime streaming compactMobile={mobile}
      showReplyQuote={visibleReplyQuoteIds([...messages,preview],activeChat.kind === 'group').has(preview.id)}
      memberProfiles={owner ? { [owner.id]: owner } : undefined}
      onReaction={inactive} onQuote={inactive} onForward={inactive} onDelete={inactive} />
  </div>
}
