import { messageItemFromRow, type RawMessageRow } from '@gugu/core/cloud/messageItem'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { chatDb } from './supabase'
import { rendererLogger } from './log'
import { foldMessageOverlays, type MessageOverlayRows } from './chatMessageRevalidation'

const writerLog = rendererLogger('chat/message-writer')

export interface IdempotentChatMessageInput {
  id: string
  chatId: string
  senderUserId: string
  toUserIds: string[] | null
  content: string
  contentType: string
  replyToMessageId: string | null
  threadRootId: string | null
  isThreadRoot: boolean
  isWhisper: boolean
}

interface MessageWriteRpc {
  rpc(
    name: string,
    args: never,
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>
}

export async function writeIdempotentChatMessage(
  input: IdempotentChatMessageInput,
  client: MessageWriteRpc = chatDb as unknown as MessageWriteRpc,
): Promise<MessageItem> {
  const { data, error } = await client.rpc('send_message_with_overlays', {
    p_message_id: input.id,
    p_chat_id: input.chatId,
    p_sender_user_id: input.senderUserId,
    p_to_user_ids: input.toUserIds,
    p_content: input.content,
    p_content_type: input.contentType,
    p_reply_to_message_id: input.replyToMessageId,
    p_thread_root_id: input.threadRootId,
    p_is_thread_root: input.isThreadRoot,
    p_is_whisper: input.isWhisper,
  } as never)
  if (error) throw new Error(error.message, { cause: error })
  const row = data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : null
  const message = row?.message && typeof row.message === 'object'
    ? messageItemFromRow(row.message as RawMessageRow, input.senderUserId)
    : null
  if (!message || !row) throw new Error('send_message_with_overlays returned an unexpected row shape', { cause: { data } })
  if (!('reactions' in row) || !('deliveries' in row) || !('delivery_blocks' in row)) {
    throw new Error('send_message_with_overlays result has no reactions / deliveries / delivery_blocks: the database is older than this client')
  }
  if (!Array.isArray(row.reactions) || !Array.isArray(row.deliveries) || !Array.isArray(row.delivery_blocks)) {
    throw new Error('send_message_with_overlays returned invalid message overlays')
  }
  Object.assign(message, foldMessageOverlays([message.id], input.senderUserId, row as unknown as MessageOverlayRows).get(message.id))
  // gugu-dev#181 ⑨ a reply to an agent's question card is its answer (questionCardAnswer.ts). The reply is sent either way;
  // an answer that does not land leaves the card waiting, where the owner sees it.
  if (message.reply_to_message_id) {
    void import('./questionCardAnswer').then(({ answerIfQuestionReply }) => answerIfQuestionReply(message, input.senderUserId))
      .catch((cause: unknown) => writerLog.error({ messageId: message.id, error: cause instanceof Error ? cause.message : String(cause) }, 'question card answer failed'))
  }
  return message
}
