import { nullableText, nullableTextArray, numberOrSentinel, text } from './payload'
import type { MessageContentType, MessageItem } from '../shared/types/chat'
import { parseFileMetadata, type FileMetadata } from '../shared/fileResolver'

// @@@ message-item-builder — see git history for full context.
// @@@threads (#957) thread_root_id：thread 回复指向其 root；主时间线据此过滤、thread 视图据此聚合。
// @@@message-edit edited_at：「已编辑」指示(列已在 base 表 + messages_view)。
// @@@whisper (#820) is_whisper：定向私密消息（仅 sender + to_user_ids 可见，列在 base 表 + messages_view + RLS）。
// @@@threads (#1196 Q2) is_thread_root：该主线消息是否话题根（开 thread 即标，让 root 立刻显 tanchor，不等首条回复）。
// #6835 via_app：App 以人的名义发的那一行是哪个 App（gugu-supabase messages_view 末列）。
// #7290 file_item_id / file_version：附件消息指向群文件夹的哪个条目、哪一版（gugu-supabase #123;字节经 attachments/urls 现签）;
//       file_blob_id：悄悄话的附件不进文件夹,消息直接指字节（能读这条消息的人才签得到）。
export const MESSAGES_VIEW_SELECT =
  'id, chat_id, sender_user_id, to_user_ids, seq, content, content_type, reply_to_message_id, reply_to_sender_user_id, reply_to_content, retracted_at, created_at, forwarded_from_message_id, thread_root_id, edited_at, is_whisper, is_thread_root, client_message_id, via_app, sent_by_agent, agent_sender, file_item_id, file_version, file_blob_id, file_metadata'

export type RawMessageRow = {
  id?: unknown
  chat_id?: unknown
  sender_user_id?: unknown
  to_user_ids?: unknown
  seq?: unknown
  content?: unknown
  content_type?: unknown
  reply_to_message_id?: unknown
  reply_to_sender_user_id?: unknown
  reply_to_content?: unknown
  retracted_at?: unknown
  created_at?: unknown
  forwarded_from_message_id?: unknown
  thread_root_id?: unknown
  edited_at?: unknown
  is_whisper?: unknown
  is_thread_root?: unknown
  client_message_id?: unknown
  via_app?: unknown
  sent_by_agent?: unknown
  agent_sender?: unknown
  file_item_id?: unknown
  file_version?: unknown
  file_blob_id?: unknown
  file_metadata?: unknown
}

function agentSenderFromRow(value: unknown): MessageItem['agent_sender'] {
  if (!value || typeof value !== 'object') return null
  const source = value as Record<string, unknown>
  const name = text(source.name)
  return name ? { id: nullableText(source.id), name } : null
}

function messageContentType(value: unknown): MessageContentType {
  return value === 'card' || value === 'system' || value === 'attachment' || value === 'widget' ? value : 'text'
}

export function messageItemFromRow(raw: RawMessageRow, currentUserId: string): MessageItem | null {
  const id = text(raw.id)
  const chatId = text(raw.chat_id)
  if (!id || !chatId) return null
  // @@@2051 注销用户:只有显式 null(ON DELETE SET NULL)= 合法注销 → 保留行、作者匿名为「已注销用户」
  // (否则消息端上消失但 server 仍计未读 = 幽灵未读)。undefined/空串/错误类型 = 缺 select 字段/脏 payload
  // → 维持 fail-loud 丢弃;❌ 别用 nullableText 把缺字段也当注销(会把脏数据伪装成注销者,与
  // deviceCommandRuntime「只跳显式 null、其余抛错」的 fail-loud 原则一致)。
  const rawSender = raw.sender_user_id
  if (rawSender !== null && !text(rawSender)) return null
  const senderUserId: string | null = rawSender === null ? null : text(rawSender)
  let fileMetadata: FileMetadata | null = null
  if (raw.file_metadata != null) {
    try { fileMetadata = parseFileMetadata(raw.file_metadata) } catch { return null }
  }
  return {
    id,
    chat_id: chatId,
    sender_user_id: senderUserId,
    to_user_ids: nullableTextArray(raw.to_user_ids),
    is_whisper: raw.is_whisper === true,
    via_app: nullableText(raw.via_app),
    sent_by_agent: raw.sent_by_agent === true,
    agent_sender: senderUserId === currentUserId && raw.sent_by_agent === true
      ? agentSenderFromRow(raw.agent_sender) : null,
    file_item_id: nullableText(raw.file_item_id),
    file_version: typeof raw.file_version === 'number' && Number.isInteger(raw.file_version) ? raw.file_version : null,
    file_blob_id: nullableText(raw.file_blob_id),
    file_metadata: fileMetadata,
    is_thread_root: raw.is_thread_root === true,
    client_message_id: nullableText(raw.client_message_id),
    seq: numberOrSentinel(raw.seq, -1),
    content: nullableText(raw.content),
    content_type: messageContentType(raw.content_type),
    reply_to_message_id: nullableText(raw.reply_to_message_id),
    reply_to_sender_user_id: nullableText(raw.reply_to_sender_user_id),
    reply_to_content: nullableText(raw.reply_to_content),
    retracted_at: nullableText(raw.retracted_at),
    created_at: text(raw.created_at) || new Date().toISOString(),
    forwarded_from_message_id: nullableText(raw.forwarded_from_message_id),
    thread_root_id: nullableText(raw.thread_root_id),
    edited_at: nullableText(raw.edited_at),
    reactions: [],
    is_mine: senderUserId === currentUserId,
    delivered: false,
    delivery_status: null,
    local_send_state: null,
  }
}
