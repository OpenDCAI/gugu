import type { AgentStatusView } from '../agentStatus'
import { chatAttention, chatDisplayName } from './chatModels'
import type { ChatItem } from '../types/chat'

export type ChatNotificationPayload = {
  title: string
  body: string
  chatId: string
}

/** 一次可能要叫人的变化:会话列表里的一行,或一条 agent 会话的状态读数。 */
export type NotificationChange =
  | { kind: 'chat'; previous: ChatItem | undefined; next: ChatItem }
  | { kind: 'agent'; previous: AgentStatusView | null; next: AgentStatusView | null }

export type NotificationContext = {
  /** 这一路通知在设置里开着。 */
  enabled: boolean
  /** 人此刻正看着它:再弹就是同一件事说两遍。 */
  onScreen: boolean
}

/**
 * 系统通知的**唯一判据**,手机和桌面、聊天和 agent 会话同一份(owner 10-30):
 * **有人(或 agent)需要你回应才弹** —— 私聊里的新消息;群/话题里叫到你的消息(点名你、@all、回复你说的那条,
 * 即服务端 list_unread_locators.addressed_count,与 agent 被叫醒同一判据);agent 停下来等你批准 / 回答。
 * 纯状态变化不弹:群里没叫到你的消息、agent 做完 / 出错 / 上线 / 开工。
 * 出口:聊天/agent 横幅；声音只跟横幅；徽标只读 chatAttention().askingYou；App/设备横幅复用通知开关及限流。
 * 会议定时提醒、登录过期、首次托盘说明与用户主动测试是写明的例外。❌ 绕过这里另开通知/声音/徽标出口。
 * 出口清单由 notificationOutlets.test.ts 强制。
 */
export function shouldNotify(change: NotificationChange, context: NotificationContext): boolean {
  if (!context.enabled || context.onScreen) return false
  if (change.kind === 'agent') return asksYou(change.next) && !sameAsk(change.previous, change.next)
  const count = chatAttention(change.next).askingYou
  return count > 0 && count > (change.previous ? chatAttention(change.previous).askingYou : 0)
}

export function asksYou(reading: AgentStatusView | null): reading is AgentStatusView {
  return reading?.status === 'needs_user'
}

/** 从「等你批准」换成「等你回答」是新的一件事;同一件等待被重推不是。 */
function sameAsk(previous: AgentStatusView | null, next: AgentStatusView): boolean {
  return asksYou(previous) && previous.detail === next.detail
}

export function createChatNotificationPayload(chat: ChatItem): ChatNotificationPayload {
  return {
    title: chatDisplayName(chat, chat.name) || '咕咕',
    body: chat.last_message_preview || '收到一条新消息',
    chatId: chat.id,
  }
}
