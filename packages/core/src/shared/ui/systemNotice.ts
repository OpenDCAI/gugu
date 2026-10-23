import { AGENT_FAILURE_REASONS, type AgentFailureReason } from '../agentQuotaReason'
import type { MessageItem } from '../types/chat'

// @@@system-notice 系统行的结构:编在 client_message_id = `<种类>:<本条消息 id>:<载荷>`。
//
// content 是给旧客户端、agent 读的纯文本;界面认出种类就按自己的语言画,认不出就照 content 显示。
// 这一列本来就在 messages_view 与实时载荷里,所以不用加列、不用改 RPC。中段必须等于本条消息 id:
// 别人自己发的消息伪造不出一条。
//  · member-joined(#6386,gugu-supabase 的 chat_members 触发器落,无发送者):载荷 = 入群者 id,逗号分隔。
//  · turn-failure(宿主替失败的 agent 落,发送者 = 那个 agent):载荷 = AgentFailureReason。

export type SystemNotice =
  | { kind: 'member-joined'; userIds: string[] }
  | { kind: 'turn-failure'; reason: AgentFailureReason }

type NoticeRow = Pick<MessageItem, 'id' | 'content_type' | 'sender_user_id' | 'client_message_id'>

export function turnFailureMarker(messageId: string, reason: AgentFailureReason): string {
  return `turn-failure:${messageId}:${reason}`
}

export function parseSystemNotice(msg: NoticeRow): SystemNotice | null {
  if (msg.content_type !== 'system') return null
  const payload = (kind: string) => {
    const head = `${kind}:${msg.id}:`
    return msg.client_message_id?.startsWith(head) ? msg.client_message_id.slice(head.length) : null
  }
  if (msg.sender_user_id === null) {
    const userIds = payload('member-joined')?.split(',').filter((id) => id.length > 0) ?? []
    return userIds.length > 0 ? { kind: 'member-joined', userIds } : null
  }
  const reason = AGENT_FAILURE_REASONS.find((known) => known === payload('turn-failure'))
  return reason ? { kind: 'turn-failure', reason } : null
}

/** The reason a turn-failure row carries; null for any other row. */
export function turnFailureReason(msg: NoticeRow): AgentFailureReason | null {
  const notice = parseSystemNotice(msg)
  return notice?.kind === 'turn-failure' ? notice.reason : null
}
