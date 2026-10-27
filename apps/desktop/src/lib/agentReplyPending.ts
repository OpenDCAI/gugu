import type { AgentDisplayStatus, MessageItem } from '@gugu/core/shared/types/chat'
import { turnFailureReason } from '@gugu/core/shared/ui/systemNotice'

/**
 * #7199 和 agent 的私聊里,人发出一句到它回话之间,它此刻是不是在处理(聊天里它干活时那个打字气泡)。
 * ❌ 另起一份状态:三件事都是现成的 ——
 *   · 那张 agent 状态表(宿主写下的读数,运行条读的同一份):在跑 = 在处理;
 *   · 它住的云电脑收回着 / 正在醒(设备行上那一格;只用来判断它是不是还在处理,❌ 给人看「休息」);
 *   · 这条私聊最后一句是不是我说的、还没人回。
 * 后两件只在「我说了还没回」时才算:醒来要先叫醒的那段、读数还没翻成「在跑」的那几秒,都还在处理里。
 * 等的那几段都有时限:过了还没翻成「在跑」/「正在醒」,就不再说它在处理(❌ 一直转下去 —— 那是在骗人)。
 */
export type AgentReplyPending = 'waking' | 'working' | null

/** 它住的云电脑此刻怎样;不住在云电脑上 = null。`since` = 管家说进入这个状态的时刻(毫秒;不知道 = null)。 */
export type AgentCloudState = { presence: 'asleep' | 'waking' | 'awake'; since: number | null } | null

/** 发出后、云电脑还没从「休息」翻到「正在醒」的那一段最多等多久:管家几秒一扫,客户端在这段里勤着问它。 */
export const WAKE_PICKUP_MS = 90_000
/** 消息到了(或它刚醒)、读数还没翻成「在跑」的那一段最多等多久:宿主收下消息、起一轮要几秒到几十秒。 */
export const START_PICKUP_MS = 45_000

type Line = Pick<MessageItem, 'is_mine' | 'created_at' | 'retracted_at' | 'content_type' | 'local_send_state' | 'thread_root_id'>
  & Partial<Pick<MessageItem, 'id' | 'sender_user_id' | 'client_message_id' | 'reply_to_message_id'>>

/** 这条线最后一句是我说的、还没人接:返回它发出的时刻(毫秒);最后一句是对方的 / 没发出去 = null。 */
export function awaitingReplyMessage<T extends Line>(messages: readonly T[]): T | null {
  const failed = new Set<string>()
  let legacyTurnEnded = false
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message.thread_root_id || message.retracted_at) continue
    if (message.content_type === 'system') {
      const reason = turnFailureReason({ id: message.id ?? '', content_type: 'system',
        sender_user_id: message.sender_user_id ?? null, client_message_id: message.client_message_id ?? null })
      if (reason && reason !== 'notAdmitted' && reason !== 'undelivered') {
        if (message.reply_to_message_id) failed.add(message.reply_to_message_id)
        else legacyTurnEnded = singleEarlierInput(messages, i)
      }
      continue
    }
    if (legacyTurnEnded || (message.id && failed.has(message.id))) return null
    if (!message.is_mine || message.local_send_state === 'failed') return null
    return Number.isFinite(Date.parse(message.created_at)) ? message : null
  }
  return null
}

/** Old notices lack a source id. Only settle their unambiguous single input, never a newer turn. */
function singleEarlierInput(messages: readonly Line[], before: number): boolean {
  let inputs = 0
  for (let i = before - 1; i >= 0; i -= 1) {
    const line = messages[i]!
    if (line.thread_root_id || line.retracted_at || line.content_type === 'system') continue
    if (!line.is_mine) break
    if (++inputs > 1) return false
  }
  return inputs === 1
}

export function awaitingReplySince(messages: readonly Line[]): number | null {
  const message = awaitingReplyMessage(messages)
  return message ? Date.parse(message.created_at) : null
}

export function agentReplyPending(input: {
  /** 那张 agent 状态表里它的展示态。 */
  status: AgentDisplayStatus
  cloud: AgentCloudState
  awaitingSince: number | null
  now: number
}): AgentReplyPending {
  const { status, cloud, awaitingSince, now } = input
  if (status === 'working') return 'working'
  if (awaitingSince === null) return null
  if (cloud?.presence === 'waking') return 'waking'
  // 发出时它在休息:私聊落成一条等它的命令,管家扫到就叫醒 —— 这一段已经是「正在醒」。
  if (cloud?.presence === 'asleep') return now - awaitingSince < WAKE_PICKUP_MS ? 'waking' : null
  // 能收:普通宿主要在线;云电脑刚醒时它那一行可能还没从离线翻过来,离线也算在等。
  const reachable = status === 'idle' || status === 'pending' || (cloud !== null && status === 'offline')
  if (!reachable) return null
  // 从「我发出」与「它醒来」里晚的那一刻算起,等读数翻成「在跑」。
  return now - pickupFrom(cloud, awaitingSince) < START_PICKUP_MS ? 'working' : null
}

function pickupFrom(cloud: AgentCloudState, awaitingSince: number): number {
  return Math.max(awaitingSince, cloud?.since ?? 0)
}

/** 光靠时间流逝、结论会在哪一刻变(到点要重算一次);不会变 = null。 */
export function agentReplyPendingDeadline(cloud: AgentCloudState, awaitingSince: number | null): number | null {
  if (awaitingSince === null) return null
  return cloud?.presence === 'asleep' ? awaitingSince + WAKE_PICKUP_MS : pickupFrom(cloud, awaitingSince) + START_PICKUP_MS
}
