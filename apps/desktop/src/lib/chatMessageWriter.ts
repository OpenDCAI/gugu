import { messageItemFromRow, type RawMessageRow } from '@gugu/core/cloud/messageItem'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { chatDb } from './supabase'
import { i18n } from '@/i18n'
import { toUserFacingError } from './userFacingError'

// @@@4891 发消息失败会经 InputArea 的 composer.sendFailed 原样弹给用户 ⇒ 这里抛出的
// message 就是用户读到的那句。开发者要的细节(RPC 名、漂掉的行结构)一律走 cause。
const sendFailed = (): string => i18n.t('errors.operationFailed', { ns: 'common' })

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
  if (error) throw toUserFacingError(error, sendFailed())
  const rows = Array.isArray(data) ? data : [data]
  const message = rows.length === 1 && rows[0] && typeof rows[0] === 'object'
    ? messageItemFromRow(rows[0] as RawMessageRow, input.senderUserId)
    : null
  if (!message) {
    // @@@4891 原来把整条 RPC 返回值 JSON.stringify 进 message —— 而这条 message 会经
    // InputArea 的 composer.sendFailed 原样弹给用户,等于把 RPC 名和原始行结构一起给出去
    // (审计里唯一一处泄的是**结构化数据**而不是一句文本)。fail-loud 照旧(仍然抛),
    // 诊断信息一条没少(进 cause),变的只是「给用户看哪一句」。
    throw toUserFacingError(
      new Error('send_message_idempotent returned an unexpected row shape', { cause: { data } }),
      sendFailed(),
    )
  }
  return message
}
