import { AGENT_FAILURE_REASONS, type AgentFailureReason } from '../agentQuotaReason'
import type { MessageItem } from '../types/chat'

// @@@system-notice 系统行的结构:编在 client_message_id = `<种类>:<本条消息 id>:<载荷>`。
//
// content 是给旧客户端、agent 读的纯文本;界面认出种类就按自己的语言画,认不出就照 content 显示。
// 这一列本来就在 messages_view 与实时载荷里,所以不用加列、不用改 RPC。三段形式的中段必须等于本条消息 id:
// 别人自己发的消息伪造不出一条。
//  · member-joined(#6386,gugu-supabase 的 chat_members 触发器落,无发送者):载荷 = 入群者 id,逗号分隔。
//  · turn-failure(宿主替失败的 agent 落,发送者 = 那个 agent):载荷 = AgentFailureReason。
//  · topic-opened(服务端开话题时落):沿用它的 topic-opened:<话题 chat id>,不从文案猜话题身份。

export type SystemNotice =
  | { kind: 'member-joined'; userIds: string[] }
  | { kind: 'turn-failure'; reason: AgentFailureReason }
  | { kind: 'topic-opened'; topicChatId: string }

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
  const topicChatId = msg.client_message_id?.match(/^topic-opened:([^:]+)$/)?.[1]
  if (topicChatId) return { kind: 'topic-opened', topicChatId }
  const reason = AGENT_FAILURE_REASONS.find((known) => known === payload('turn-failure'))
  return reason ? { kind: 'turn-failure', reason } : null
}

/** The reason a turn-failure row carries; null for any other row. */
export function turnFailureReason(msg: NoticeRow): AgentFailureReason | null {
  const notice = parseSystemNotice(msg)
  return notice?.kind === 'turn-failure' ? notice.reason : null
}

/** A row saying the host holds messages for an agent that has not taken them yet (`agentInboxReader` notAdmitted,
 * `deviceCommandRuntime` undelivered). Not drawn: the waiting messages carry it on their own bubbles (queuedMessageIds). */
export function isPendingDelivery(msg: NoticeRow): boolean {
  const reason = turnFailureReason(msg)
  return reason === 'notAdmitted' || reason === 'undelivered'
}

export function visibleDeliveryMessages<T extends MessageItem>(messages: readonly T[]): T[] {
  return messages.filter(msg => !isPendingDelivery(msg))
}

type WaitLine = Pick<MessageItem, 'id' | 'seq' | 'is_mine' | 'retracted_at' | 'thread_root_id' | 'content_type' | 'sender_user_id' | 'client_message_id' | 'readers' | 'delivery_blocks'>
type Waiting = { message: WaitLine; agentId: string; rowSeq: number }

/** My messages an agent with a pending-delivery row in their line has not read yet (its precise read row or watermark). */
function waitingOn(messages: readonly WaitLine[], memberReadSeqs: Readonly<Record<string, number>>): Waiting[] {
  const rowsByThread = new Map<string | null, Map<string, number>>()
  for (const msg of messages) {
    if (!msg.sender_user_id || !isPendingDelivery(msg)) continue
    const rows = rowsByThread.get(msg.thread_root_id ?? null) ?? new Map<string, number>()
    rows.set(msg.sender_user_id, Math.max(rows.get(msg.sender_user_id) ?? 0, msg.seq))
    rowsByThread.set(msg.thread_root_id ?? null, rows)
  }
  const waiting: Waiting[] = []
  for (const message of messages) {
    if (!message.is_mine || message.seq <= 0 || message.retracted_at || message.content_type === 'system') continue
    for (const [agentId, rowSeq] of rowsByThread.get(message.thread_root_id ?? null) ?? []) {
      if (message.readers?.includes(agentId) || (memberReadSeqs[agentId] ?? 0) >= message.seq) continue
      if (message.delivery_blocks?.some((block) => block.agent_user_id === agentId)) continue
      waiting.push({ message, agentId, rowSeq })
    }
  }
  return waiting
}

/** What to look up in `chat.message_agent_wakes` before `queuedMessageIds` can answer. */
export function pendingDeliveryMessageIds(messages: readonly WaitLine[], memberReadSeqs: Readonly<Record<string, number>>): string[] {
  return [...new Set(waitingOn(messages, memberReadSeqs).map((wait) => wait.message.id))].sort()
}

/**
 * My messages still queued for an agent: it has a pending-delivery row in their line that still holds one of its unread
 * messages from before the row, and this message wakes it (`wakes` = chat.message_agent_wakes, the host's own answer).
 * Reading a message takes it out; once the agent has read everything the row held, the row holds nothing more.
 */
export function queuedMessageIds(
  messages: readonly WaitLine[],
  memberReadSeqs: Readonly<Record<string, number>>,
  wakes: ReadonlyMap<string, ReadonlySet<string>>,
): Set<string> {
  const byLine = new Map<string, Waiting[]>()
  for (const wait of waitingOn(messages, memberReadSeqs)) {
    if (!wakes.get(wait.message.id)?.has(wait.agentId)) continue
    const key = JSON.stringify([wait.message.thread_root_id ?? null, wait.agentId])
    byLine.set(key, [...(byLine.get(key) ?? []), wait])
  }
  const queued = new Set<string>()
  for (const waits of byLine.values()) {
    if (!waits.some((wait) => wait.message.seq < wait.rowSeq)) continue
    for (const wait of waits) queued.add(wait.message.id)
  }
  return queued
}
