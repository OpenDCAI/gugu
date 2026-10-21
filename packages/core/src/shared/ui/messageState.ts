import type { MessageItem, MessageSendState } from '../types/chat'

type DeliveryStatus = NonNullable<MessageItem['delivery_status']>

const deliveryRank: Record<DeliveryStatus, number> = {
  delivered: 1,
  read: 2,
}

export function maxDeliveryStatus(
  a: MessageItem['delivery_status'],
  b: MessageItem['delivery_status'],
): MessageItem['delivery_status'] {
  if (!a) return b
  if (!b) return a
  return deliveryRank[a] >= deliveryRank[b] ? a : b
}

export function mergeMessageState(existing: MessageItem | undefined, incoming: MessageItem): MessageItem {
  if (!existing) return incoming

  const deliveryStatus = maxDeliveryStatus(existing.delivery_status, incoming.delivery_status)
  const delivered = existing.delivered || incoming.delivered || deliveryStatus !== null
  const isPersisted = incoming.seq >= 0
  const localSendState = isPersisted
    ? null
    : incoming.local_send_state ?? existing.local_send_state ?? null
  // @@@per-message-read (#598) - reads are monotonic; UNION readers so a stale fetch can't drop a
  // realtime-added reader (mirrors the non-downgrade of delivery_status above).
  const mergedReaders =
    existing.readers?.length || incoming.readers?.length
      ? [...new Set([...(existing.readers ?? []), ...(incoming.readers ?? [])])]
      : incoming.readers

  return {
    ...incoming,
    delivered,
    delivery_status: deliveryStatus,
    readers: mergedReaders,
    local_send_state: localSendState,
  }
}

// @@@1529 member read watermark is monotonic — the server only ever advances last_read_seq. Apply a realtime
// member_read_changed delta as a non-downgrading merge (mirrors the readers UNION above) so a stale/out-of-order
// event can never revert 已读 back to 未读 (the initial DM row's 已读→未读 flicker). Returns the SAME reference
// when no advance happens, so a React state setter skips a needless re-render.
export function advanceMemberReadSeq(
  prev: Record<string, number>,
  userId: string,
  lastReadSeq: number,
): Record<string, number> {
  const current = prev[userId] ?? -1
  if (lastReadSeq <= current) return prev
  return { ...prev, [userId]: lastReadSeq }
}

// @@@1529 merge a fresh DB snapshot of member read watermarks into the current map, monotonically. The
// snapshot is authoritative for MEMBERSHIP — the result key set is the snapshot's, so a member who left is
// dropped from the unread denominator and a member present in the snapshot is included. But each watermark is
// monotonic, so keep max(prev, snapshot) per member: a snapshot issued before an agent's mark_read committed
// can't drag a 已读 back to 未读 on chat open / gap-heal (the #1529 flicker that also hit the snapshot paths,
// not just the realtime handler). Callers must only use this for a snapshot of the SAME chat the map already
// represents; a different chat's snapshot must wholesale-replace (no shared-watermark borrow across chats).
export function mergeMemberReadSeqs(
  prev: Record<string, number>,
  snapshot: Record<string, number>,
): Record<string, number> {
  const result: Record<string, number> = {}
  for (const userId of Object.keys(snapshot)) {
    const prevSeq = prev[userId] ?? -1
    result[userId] = prevSeq > snapshot[userId] ? prevSeq : snapshot[userId]
  }
  return result
}

export function applyDeliveryReceipt(
  message: MessageItem,
  receipt: { status?: DeliveryStatus | null; device_id?: string | null },
  currentUserId: string,
): MessageItem {
  const isCurrentUserDevice = receipt.device_id === `gugu-agent:${currentUserId}`
  return {
    ...message,
    delivered: true,
    delivery_status: isCurrentUserDevice
      ? maxDeliveryStatus(message.delivery_status, receipt.status ?? null)
      : message.delivery_status,
  }
}

// @@@recipient-read (#521) - last_read_seq per OTHER member of the chat (the viewer is excluded
// upstream, where the map is built with `.neq('user_id', self)`).
export type MemberReadSeqs = Record<string, number>

// A message is "directed" when it carries an explicit non-empty to_user_ids that isn't the
// broadcast sentinel '*'. The three read-derivations below all branch on this same predicate:
// directed → recipients = to_user_ids ∩ members; otherwise → all OTHER members. Factored out so the
// rule lives in one place (the `to_user_ids!` non-null assertions at call sites stay guarded by it).
function isDirectedMessage(message: MessageItem): boolean {
  const ids = message.to_user_ids
  return !!ids && ids.length > 0 && !ids.includes('*')
}

// @@@recipient-read (#521) - a message is read once every one of ITS recipients has read it (their
export function isReadByRecipients(message: MessageItem, memberReadSeqs: MemberReadSeqs): boolean {
  const others = Object.keys(memberReadSeqs)
  const directed = isDirectedMessage(message)
  const recipients = directed
    ? message.to_user_ids!.filter((id) => id in memberReadSeqs)
    : others
  if (recipients.length === 0) return false
  return recipients.every((id) => memberReadSeqs[id] >= message.seq)
}

// @@@per-message-read (#598) - per-message set of recipient user_ids that have read it, sourced from
// chat.message_deliveries 'read' rows (agents). Decoupled from the monotonic last_read_seq watermark:
// a directed message's receipt can flip to 已读 even when earlier directed-to-OTHERS messages keep the
// agent's watermark behind (the watermark stays honest for unread counts; the guard is untouched).
export type MessageReaders = Record<string, ReadonlySet<string>>

// @@@per-message-read (#598) - extract the agent's user_id from a message_deliveries device_id
// ('gugu-agent:<uid>'); null for anything that isn't an agent delivery row.
export function agentReaderUserId(deviceId: string | null | undefined): string | null {
  if (!deviceId) return null
  const prefix = 'gugu-agent:'
  return deviceId.startsWith(prefix) ? deviceId.slice(prefix.length) || null : null
}

// @@@per-message-read (#598) - a message is read once every one of ITS *current* recipients has a
// per-message read row. `memberIds` = current OTHER members (excludes sender); a recipient who left
// the group drops out of the denominator (S-L5). Recipients are fixed by to_user_ids at send time (S-L1).
export function isReadByRecipientsPrecise(
  message: MessageItem,
  memberIds: readonly string[],
  messageReaders: MessageReaders,
): boolean {
  const readers = messageReaders[message.id]
  if (!readers || readers.size === 0) return false
  const directed = isDirectedMessage(message)
  const recipients = directed
    ? message.to_user_ids!.filter((id) => memberIds.includes(id))
    : memberIds
  if (recipients.length === 0) return false
  return recipients.every((id) => readers.has(id))
}

export function deriveMessageSendState(
  message: MessageItem,
  memberReadSeqs: MemberReadSeqs,
  // @@@per-message-read (#598) - optional precise read source; when present it can flip 已读 independently
  // of the watermark (fixes agent directed-message receipts). Falls back to the watermark path otherwise.
  precise?: { memberIds: readonly string[]; messageReaders: MessageReaders },
): MessageSendState {
  if (message.local_send_state === 'failed') return 'failed'
  if (message.local_send_state === 'sending' || message.seq < 0) return 'sending'
  const preciseRead = precise
    ? isReadByRecipientsPrecise(message, precise.memberIds, precise.messageReaders)
    : false
  if (message.delivery_status === 'read' || preciseRead || isReadByRecipients(message, memberReadSeqs)) return 'read'
  if (message.delivered || message.delivery_status === 'delivered') return 'delivered'
  return 'sent'
}

// @@@1313 逐成员读回执（水位派生，不建逐条表，Supervisor 拍板）：
// 消息「已读成员」= 其收件方中 last_read_seq ≥ message.seq 的成员（∪ agent 的 precise 读行）。
// 「已读 N / 未读 M」+ 已读名单全派生自现有 memberReadSeqs（per-other-member 水位）；群聊/私聊同机制。
export interface MessageReadReceipt {
  // 已读人数（收件方中已读的）。
  readCount: number
  // 未读人数（收件方总数 − 已读）。
  unreadCount: number
  // 收件方总数（分母）。
  totalRecipients: number
  // 已读成员 user_id 列表（供 UI 展示头像/名单）。
  readerIds: string[]
  // @@@1345 收件方全员 user_id 列表（分母成员）。未读名单 = recipientIds \ readerIds，供点击圆环弹层用。
  recipientIds: string[]
}

// 派生某消息的逐成员读回执。memberReadSeqs = per-OTHER-member 水位（viewer 已在上游排除）。
// precise（可选）= agent 的 message_deliveries 'read' 行，与水位并集（与 deriveMessageSendState 一致口径）。
export function deriveReadReceipt(
  message: MessageItem,
  memberReadSeqs: MemberReadSeqs,
  precise?: { messageReaders: MessageReaders },
): MessageReadReceipt {
  const others = Object.keys(memberReadSeqs)
  // 收件方：定向消息取 to_user_ids ∩ 成员；否则全体其他成员（与 isReadByRecipients 同口径）。
  const directed = isDirectedMessage(message)
  const recipients = directed ? message.to_user_ids!.filter((id) => id in memberReadSeqs) : others

  const preciseReaders = precise?.messageReaders[message.id]
  const readerIds = recipients.filter(
    (id) => memberReadSeqs[id] >= message.seq || (!!preciseReaders && preciseReaders.has(id)),
  )
  const totalRecipients = recipients.length
  const readCount = readerIds.length
  return {
    readCount,
    unreadCount: Math.max(0, totalRecipients - readCount),
    totalRecipients,
    readerIds,
    recipientIds: recipients,
  }
}
