import { markStreamRead } from './chatMemberReadState'
import { UI_EVENTS } from './uiEvents'
import type { ChatUnreadLocator, MessageItem } from '@gugu/core/shared/types/chat'
import { persistManualUnread } from '../store/chatRealtimeMutations'
import { rendererLogger } from './log'
import type { UnreadLocatorCommit } from './chatUnreadLocatorWindow'

const unreadLocatorLog = rendererLogger('chat/unread-locator')

export function markThreadStreamRead(chatId: string, rootId: string, seq: number): void {
  void markStreamRead(chatId, `thread:${chatId}:${rootId}`, seq, rootId)
    .catch((err) => unreadLocatorLog.error({ error: String(err) }, 'mark thread read failed'))
}

export function markLatestThreadRead(chatId: string, rootId: string, messages: readonly MessageItem[]): void {
  const latest = messages.filter((message) => message.seq >= 0).sort((a, b) => b.seq - a.seq)[0]
  if (latest) markThreadStreamRead(chatId, rootId, latest.seq)
}

export function markManualUnreadAndRefresh(
  chatId: string,
  deps: {
    chats: Parameters<typeof persistManualUnread>[0]
    patchChat: Parameters<typeof persistManualUnread>[2]
    toast: Parameters<typeof persistManualUnread>[3]
    refresh: (options?: { acceptEmpty?: boolean }) => Promise<void>
  },
): Promise<void> {
  return persistManualUnread(deps.chats, chatId, deps.patchChat, deps.toast).then(() => deps.refresh({ acceptEmpty: true }))
}

export type OpenableUnreadTarget = {
  chatId: string
  locator: ChatUnreadLocator & { message_id: string; message_seq: number }
}

export type UnreadMessageRevealRequest = {
  token: string
  chatId: string
  streamId: string
  streamKind: 'main' | 'thread'
  threadRootId: string | null
  messageId: string
  messageSeq: number
  isCurrent?: () => boolean
  confirm: (messageId: string) => void
  reject: (reason: unknown) => void
}

export function requestUnreadMessageReveal(target: OpenableUnreadTarget, isCurrent?: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const token = crypto.randomUUID()
    const finish = (error?: unknown) => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      if (error === undefined) resolve()
      else reject(error)
    }
    const timer = window.setTimeout(() => finish(new Error(`Unread locator ${target.locator.message_id} was not rendered`)), 5000)
    const detail: UnreadMessageRevealRequest = {
      token,
      chatId: target.chatId,
      streamId: target.locator.stream_id,
      streamKind: target.locator.stream_kind,
      threadRootId: target.locator.thread_root_id,
      messageId: target.locator.message_id,
      messageSeq: target.locator.message_seq,
      isCurrent,
      confirm: (messageId) => {
        if (isCurrent && !isCurrent()) {
          finish(new DOMException('Unread navigation was superseded', 'AbortError'))
          return
        }
        if (messageId !== target.locator.message_id) {
          finish(new Error(`Unread locator rendered the wrong message ${messageId}`))
          return
        }
        finish()
      },
      reject: (reason) => finish(reason instanceof Error ? reason : new Error(String(reason))),
    }
    window.dispatchEvent(new CustomEvent(UI_EVENTS.openUnreadMessage, { detail }))
  })
}

// @@@4258 — `markRead` 收的是 `ensureMessageLoaded` 真正提交下来的那份 commit，不是 locator 自己。
// locator 只说"从哪条开始未读"；水位提交的是"这次真拉进行集的最大已落定 seq"，两者被当成同一个数用
// 就是 #4258 的形状（badge 前进了一条、那条之后的消息却不在行集里）。顺序仍是硬约束：呈现确认
// (revealMessage) 在提交水位之前，任一步失败都保留未读。
export async function openStreamAtLocator(
  target: OpenableUnreadTarget,
  deps: {
    activateChat: (chatId: string) => Promise<void>
    ensureMessageLoaded: (target: OpenableUnreadTarget) => Promise<UnreadLocatorCommit>
    revealMessage: (target: OpenableUnreadTarget) => Promise<void>
    markRead: (target: OpenableUnreadTarget, commit: UnreadLocatorCommit) => Promise<void>
    refreshChats: () => Promise<void>
  },
): Promise<void> {
  await deps.activateChat(target.chatId)
  const commit = await deps.ensureMessageLoaded(target)
  await deps.revealMessage(target)
  await deps.markRead(target, commit)
  await deps.refreshChats()
}
