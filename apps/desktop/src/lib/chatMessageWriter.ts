import { messageItemFromRow, type RawMessageRow } from '@gugu/core/cloud/messageItem'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { chatDb } from './supabase'
import { rendererLogger } from './log'

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
  const { data, error } = await client.rpc('send_message_idempotent', {
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
  const rows = Array.isArray(data) ? data : [data]
  const message = rows.length === 1 && rows[0] && typeof rows[0] === 'object'
    ? messageItemFromRow(rows[0] as RawMessageRow, input.senderUserId)
    : null
  if (!message) throw new Error('send_message_idempotent returned an unexpected row shape', { cause: { data } })
  // gugu-dev#181 ⑨ a reply to an agent's question card is its answer (questionCardAnswer.ts). The reply is sent either way;
  // an answer that does not land leaves the card waiting, where the owner sees it.
  if (message.reply_to_message_id) {
    void import('./questionCardAnswer').then(({ answerIfQuestionReply }) => answerIfQuestionReply(message, input.senderUserId))
      .catch((cause: unknown) => writerLog.error({ messageId: message.id, error: cause instanceof Error ? cause.message : String(cause) }, 'question card answer failed'))
  }
  return message
}
