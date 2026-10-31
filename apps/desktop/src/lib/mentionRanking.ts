import type { MessageItem } from '@gugu/core/shared/types/chat'
import type { MentionCandidate } from './mention'
import { mentionMatchScore } from './mentionMatch'

type HistoryMessage = Pick<MessageItem, 'id' | 'chat_id' | 'sender_user_id' | 'to_user_ids' | 'reply_to_message_id'
  | 'reply_to_sender_user_id' | 'created_at' | 'content_type' | 'seq' | 'retracted_at' | 'local_send_state' | 'sent_by_agent' | 'via_app'>

interface MentionRankingContext {
  chatId: string | null | undefined
  currentUserId: string | null | undefined
  messages: readonly HistoryMessage[]
  participantIds?: readonly string[]
  projectMemberIds?: readonly string[]
  replyToMessageId?: string
  now: number
}

const DAY = 86_400_000

/** Rank only the supplied addressable roster, using known local history, never fetching older messages. */
export function rankMentionCandidates<T extends MentionCandidate>(
  candidates: readonly T[], query: string, context: MentionRankingContext,
): T[] {
  const { chatId, currentUserId, participantIds, projectMemberIds, replyToMessageId, now } = context
  const messages = context.messages.filter((message) => message.chat_id === chatId && message.seq >= 0
    && !message.local_send_state && !message.retracted_at && message.content_type !== 'system'
    && Number.isFinite(Date.parse(message.created_at)))
  const byId = new Map(messages.map((message) => [message.id, message]))
  const replyTargetId = replyToMessageId ? byId.get(replyToMessageId)?.sender_user_id : null
  const participants = new Set(participantIds)
  const projectMembers = new Set(projectMemberIds)
  const lastSpoke = new Map<string, number>()
  const lastAddressed = new Map<string, number>()
  const remember = (times: Map<string, number>, id: string | null | undefined, at: number) => {
    if (id && id !== '*') times.set(id, Math.max(times.get(id) ?? -Infinity, at))
  }
  for (const message of messages) {
    const at = Date.parse(message.created_at)
    remember(lastSpoke, message.sender_user_id, at)
    if (!currentUserId || message.sender_user_id !== currentUserId || message.sent_by_agent || message.via_app) continue
    for (const id of message.to_user_ids ?? []) remember(lastAddressed, id, at)
    const repliedTo = message.reply_to_sender_user_id
      ?? (message.reply_to_message_id ? byId.get(message.reply_to_message_id)?.sender_user_id : null)
    remember(lastAddressed, repliedTo, at)
  }
  const decay = (at: number | undefined, halfLife: number) => at === undefined ? 0 : 2 ** (-Math.max(0, now - at) / halfLife)
  return candidates
    .map((candidate, index) => ({
      candidate, index, match: mentionMatchScore(candidate, query),
      broadcast: candidate.type === 'all' ? 1 : 0,
      participant: participants.has(candidate.id) ? 1 : 0,
      replyTarget: candidate.id === replyTargetId ? 1 : 0,
      // The existing interaction signal is at most 3; project agents take precedence within that tier.
      relevance: (candidate.type === 'agent' && projectMembers.has(candidate.id) ? 4 : 0)
        + 2 * decay(lastAddressed.get(candidate.id), 7 * DAY) + decay(lastSpoke.get(candidate.id), DAY),
    }))
    .filter((row) => row.match > 0)
    .sort((a, b) => b.match - a.match || a.broadcast - b.broadcast || b.participant - a.participant
      || b.replyTarget - a.replyTarget || b.relevance - a.relevance || a.index - b.index)
    .map((row) => row.candidate)
}
