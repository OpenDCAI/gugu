import type { MessageItem } from '../types/chat'

// @@@6386 「X 加入了群聊」系统消息的解析。
//
// 服务端(gugu-supabase 的 20260924090000_group_member_join_notice_6386.sql,chat_members 上的触发器)
// 落的是一条普通系统消息:content 是给旧客户端和 agent 读的纯文本,入群者 id 编在
//   client_message_id = 'member-joined:<消息 id>:<uid>,<uid>…'
// 这一列本来就在 messages_view 与实时载荷里,所以不用加列、不用改 RPC。
// 只认服务端写的那种(系统消息 + 无发送者 + 中段等于本条消息 id):任何人自己发的消息都伪造不出一条。

const PREFIX = 'member-joined:'

export function parseMemberJoinNotice(msg: Pick<MessageItem, 'id' | 'content_type' | 'sender_user_id' | 'client_message_id'>): string[] | null {
  if (msg.content_type !== 'system' || msg.sender_user_id !== null) return null
  const marker = msg.client_message_id
  if (!marker?.startsWith(PREFIX)) return null
  const rest = marker.slice(PREFIX.length)
  const separator = rest.indexOf(':')
  if (separator < 0 || rest.slice(0, separator) !== msg.id) return null
  const userIds = rest.slice(separator + 1).split(',').filter((id) => id.length > 0)
  return userIds.length > 0 ? userIds : null
}
