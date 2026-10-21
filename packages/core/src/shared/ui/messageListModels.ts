import { mergeMessageState } from './messageState'
import type { MessageItem, ReactionGroup } from '../types/chat'

function sameReactions(a: ReactionGroup[], b: ReactionGroup[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].emoji !== b[i].emoji || a[i].count !== b[i].count || a[i].my_reaction !== b[i].my_reaction) return false
  }
  return true
}

function sameRecipientIds(a: MessageItem['to_user_ids'], b: MessageItem['to_user_ids']): boolean {
  if (a === b) return true
  if (a === null || b === null) return a === b
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

// @@@2051 注销用户:气泡分组以「同一发送者」为条件,但注销者 sender_user_id 全是 null → 裸 `===` 让
// null===null 把不同注销者错误合组(后条头像/名被隐藏)。匿名化已失去稳定身份 → null sender 强制断组。
export function computeGroupedWithPrev(params: {
  isFiltering: boolean
  showTimeDivider: boolean
  prevMsg: MessageItem | null
  msg: MessageItem
  prevIsThreadRoot: boolean
}): boolean {
  const { isFiltering, showTimeDivider, prevMsg, msg, prevIsThreadRoot } = params
  return (
    !isFiltering &&
    !showTimeDivider &&
    !!prevMsg &&
    msg.sender_user_id !== null &&
    prevMsg.sender_user_id === msg.sender_user_id &&
    msg.content_type !== 'system' &&
    prevMsg.content_type !== 'system' &&
    !msg.is_whisper &&
    !prevMsg.is_whisper &&
    !msg.retracted_at &&
    !prevMsg.retracted_at &&
    !prevIsThreadRoot
  )
}

export function shallowEqualMessage(a: MessageItem, b: MessageItem): boolean {
  return (
    a.id === b.id &&
    a.seq === b.seq &&
    a.content === b.content &&
    a.content_type === b.content_type &&
    a.retracted_at === b.retracted_at &&
    a.created_at === b.created_at &&
    a.reply_to_message_id === b.reply_to_message_id &&
    a.sender_user_id === b.sender_user_id &&
    sameRecipientIds(a.to_user_ids, b.to_user_ids) &&
    a.is_mine === b.is_mine &&
    a.delivered === b.delivered &&
    a.delivery_status === b.delivery_status &&
    a.local_send_state === b.local_send_state &&
    sameReactions(a.reactions, b.reactions)
  )
}

// @@@message-order-invariant - a chat's canonical order is the server-assigned `seq` (monotonic per
function compareMessageOrder(a: MessageItem, b: MessageItem): number {
  const aPending = a.seq < 1
  const bPending = b.seq < 1
  if (aPending !== bPending) return aPending ? 1 : -1
  if (!aPending) return a.seq - b.seq
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export function mergeMessagesById(prev: MessageItem[], fresh: MessageItem[], chatId: string): MessageItem[] {
  const prevById = new Map<string, MessageItem>()
  for (const p of prev) prevById.set(p.id, p)

  const out: MessageItem[] = []
  const seen = new Set<string>()
  for (const f of fresh) {
    // @@@chat-bleed (critical): never merge a message whose chat_id doesn't match this list's chat.
    // A poisoned cache (another chat's messages written here via a cross-chat prev-bleed) must not
    // survive a merge — drop foreign entries from `fresh` just as `prev` is filtered below.
    if (f.chat_id !== chatId) continue
    seen.add(f.id)
    const existing = prevById.get(f.id)
    const merged = mergeMessageState(existing, f)
    out.push(existing && shallowEqualMessage(existing, merged) ? existing : merged)
  }
  for (const p of prev) {
    if (!seen.has(p.id) && p.chat_id === chatId) out.push(p)
  }
  out.sort(compareMessageOrder)
  return out
}

// @@@2015 — 乐观回复必须带全引用预览(user_id/content):只带 reply_to_message_id 时,
// 回声到达前气泡引用条渲染空名、每次重渲染触发一条 #1624 fail-loud(outbox 异步投递让乐观窗口秒级,
// 活跃群里单条回复能刷 8+ 条 error),用户可见名字/正文空白闪烁。回复目标就是用户点的那条气泡,
// 必在本地窗口内;语义镜像 chat.message_reply_preview(whisper 不出预览、正文截 280)。目标不在窗口
// 的罕见路径只回传 id——渲染层继续 fail loud,不兜底。
export function optimisticReplyFields(
  window: MessageItem[],
  replyToMessageId: string | null,
): Pick<MessageItem, 'reply_to_message_id' | 'reply_to_sender_user_id' | 'reply_to_content'> {
  const target = replyToMessageId ? window.find((m) => m.id === replyToMessageId) : undefined
  if (!target || target.is_whisper) {
    return { reply_to_message_id: replyToMessageId, reply_to_sender_user_id: null, reply_to_content: null }
  }
  return {
    reply_to_message_id: replyToMessageId,
    reply_to_sender_user_id: target.sender_user_id,
    reply_to_content: (target.content ?? '').slice(0, 280),
  }
}

export function upsertMessageById(list: MessageItem[], msg: MessageItem): MessageItem[] {
  let replaced = false
  const next = list.map((existing) => {
    if (existing.id !== msg.id) return existing
    replaced = true
    const merged = mergeMessageState(existing, msg)
    return shallowEqualMessage(existing, merged) ? existing : merged
  })
  const result = replaced ? next : [...next, msg]
  result.sort(compareMessageOrder)
  return result
}
