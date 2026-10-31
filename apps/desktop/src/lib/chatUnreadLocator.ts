import { cloudReadTarget, writeRead } from './readWriter'
import { chatDb } from './supabase'
import { UI_EVENTS } from './uiEvents'
import type { ChatItem, ChatUnreadLocator, MessageItem } from '@gugu/core/shared/types/chat'
import { persistManualUnread } from '../store/chatRealtimeMutations'
import { rendererLogger } from './log'
import type { UnreadLocatorCommit } from './chatUnreadLocatorWindow'

const unreadLocatorLog = rendererLogger('chat/unread-locator')

export function markThreadStreamRead(chatId: string, rootId: string, seq: number): void {
  void writeRead(cloudReadTarget(chatId, rootId, seq))
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

// @@@mark-all-read — 给定范围内每条未读流(主线 + 每个话题)各发一次现成的已读 RPC。seq 取点击时 store 里的
// next_message_seq-1:seq 是整个会话共用的计数(话题回复也占号),点击之后到的消息都比它大,留作未读;
// 第一条未读已经比它大的流(store 还没跟上)跳过。部分失败不回滚,返回失败的会话数。
export async function markChatsReadAndRefresh(deps: {
  chats: readonly ChatItem[]
  refresh: (options?: { acceptEmpty?: boolean }) => Promise<void>
  /** 自动清除保留当前服务端人工标记;显式「全部标已读」默认仍清除它。 */
  preserveManualUnread?: boolean
  /** 取未读流期间用户可能更新读意图,自动写入前再核对一次。 */
  canMarkRead?: (chatId: string) => boolean
}): Promise<{ failedChats: number; error?: unknown }> {
  const seenSeq = new Map(deps.chats.map((chat) => [chat.id, chat.next_message_seq - 1]))
  const { data, error } = await chatDb.rpc('list_unread_locators', { p_chat_id: null })
  if (error) throw new Error(error.message)
  const rows = (data ?? []) as Array<Record<string, unknown>>
  const manuallyUnread = new Set(deps.preserveManualUnread ? rows.filter(row => row.is_marked_unread === true).map(row => String(row.chat_id)) : [])
  const failedChatIds = new Set<string>()
  let failure: unknown
  await Promise.all(rows.map(async (row) => {
    const chatId = String(row.chat_id)
    const seq = seenSeq.get(chatId)
    if (seq === undefined || manuallyUnread.has(chatId) || Number(row.message_seq) > seq || deps.canMarkRead?.(chatId) === false) return
    const rootId = typeof row.thread_root_id === 'string' ? row.thread_root_id : null
    try {
      await writeRead(cloudReadTarget(chatId, rootId, seq))
    } catch (err) {
      failedChatIds.add(chatId)
      failure ??= err
      unreadLocatorLog.error({ error: String(err), chatId, streamId: row.stream_id }, 'mark all read failed')
    }
  }))
  await deps.refresh({ acceptEmpty: true })
  return { failedChats: failedChatIds.size, ...(failedChatIds.size ? { error: failure } : {}) }
}

export type OpenableUnreadTarget = {
  chatId: string
  locator: ChatUnreadLocator & { message_id: string; message_seq: number }
}

export type CapturedUnreadEntry = OpenableUnreadTarget & { onSeen: () => void }

export type UnreadMessageRevealRequest = {
  token: string
  commit?: UnreadLocatorCommit
  viewport?: HTMLElement | 'primary' | null
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

export function requestUnreadMessageReveal(target: OpenableUnreadTarget, isCurrent?: () => boolean, viewport?: HTMLElement | 'primary' | null, commit?: UnreadLocatorCommit): Promise<void> {
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
      token, commit, viewport: viewport ?? 'primary',
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
    revealMessage: (target: OpenableUnreadTarget, commit: UnreadLocatorCommit) => Promise<void>
    markRead: (target: OpenableUnreadTarget, commit: UnreadLocatorCommit) => Promise<void>
    refreshChats: () => Promise<void>
  },
): Promise<void> {
  await deps.activateChat(target.chatId)
  const commit = await deps.ensureMessageLoaded(target)
  await deps.revealMessage(target, commit)
  await deps.markRead(target, commit)
  await deps.refreshChats()
}
