// 会话页需要知道的对话摘要(gugu-dev#181):每个对话 id → { 有没有过消息, 叫什么 }。
//   · 有没有过消息:项目群里还没有消息时,项目块正中是文件夹卡和输入框;有了才是消息流。
//   · 叫什么:会话里「来自 X」那一句 —— 投递信封里只有群号(给 agent 寻址),人读群名。
//   · 是群还是私聊:块页签的右键菜单(私聊没有群公告)。
//   · 最后一句、话题从哪个对话开出来:⌘K 那个面板在会话页一次搜对话和话题(名字、最后一句),打开话题要先开它的源对话。
//
// 壳那棵树知道每个对话(聊天列表那一份),会话页不知道:壳写、会话页读,同一个 window 对象 +
// 一个 window 事件(谁先起来都接得上)。两边都只 import 这一个文件,❌ 各写一份键名。
import { useSyncExternalStore } from 'react'

export type ChatSummary = {
  readonly peerUserId?: string | null
  readonly firstUnreadMessageId?: string | null
  readonly alias?: string | null
  readonly publicId?: number
  readonly unreadCount: number
  readonly isMarkedUnread: boolean
  readonly hasMessages: boolean
  readonly name: string | null
  readonly kind: string | null
  readonly lastMessagePreview: string | null
  /** 话题从哪个对话开出来;别的 = null。 */
  readonly sourceChatId: string | null
}

const KEY = '__GUGU_CHAT_SUMMARIES__'
const EVENT = 'gugu:chat-summaries'

type Summaries = ReadonlyMap<string, ChatSummary>

/** 壳:聊天列表那一份(整份替换;没变不通知)。 */
export function publishChatSummaries(chats: readonly {
  peer_user_id?: string | null; unread_locator?: { message_id: string | null } | null; id: string; kind: string; unread_count: number; is_marked_unread?: boolean; name?: string | null; alias?: string | null; public_id?: number | null; last_message_at?: string | null; last_message_preview?: string | null; source_chat_id?: string | null
}[]): void {
  const next: Summaries = new Map(chats.map((chat) => [chat.id, {
    ...(chat.alias ? { alias: chat.alias } : {}),
    ...(typeof chat.public_id === 'number' && Number.isSafeInteger(chat.public_id) && chat.public_id > 0 ? { publicId: chat.public_id } : {}),
    peerUserId: chat.peer_user_id ?? null,
    firstUnreadMessageId: chat.unread_locator?.message_id ?? null,
    unreadCount: chat.unread_count,
    isMarkedUnread: chat.is_marked_unread === true,
    hasMessages: Boolean(chat.last_message_at),
    name: chat.name || null,
    kind: chat.kind,
    lastMessagePreview: chat.last_message_preview || null,
    sourceChatId: chat.source_chat_id || null,
  }]))
  const current = read()
  if (current && current.size === next.size && [...next].every(([id, summary]) => {
    const was = current.get(id)
    return was !== undefined && was.alias === summary.alias && was.publicId === summary.publicId && (Object.keys(summary) as (keyof ChatSummary)[]).every((key) => was[key] === summary[key])
  })) return
  ;(window as unknown as Record<string, unknown>)[KEY] = next
  window.dispatchEvent(new Event(EVENT))
}

function read(): Summaries | null {
  return ((window as unknown as Record<string, unknown>)[KEY] as Summaries | undefined) ?? null
}

/** 会话页(不在渲染里):壳那份全部对话(属于我的每一个);壳还没读成过 = null。 */
export const readChatSummaries = read

/** A message_send address can be a UUID or a public number; resolve it using the signed-in chat list. */
export function resolveChatId(address: string): string | null {
  const summaries = read()
  if (summaries?.has(address)) return address
  if (!/^[1-9]\d*$/.test(address)) return null
  const publicId = Number(address)
  if (!Number.isSafeInteger(publicId)) return null
  for (const [id, summary] of summaries ?? []) if (summary.publicId === publicId) return id
  return null
}

/** 会话页:壳那边的对话变了(有了消息、改了名)。 */
export function subscribeChatSummaries(listener: () => void): () => void {
  window.addEventListener(EVENT, listener)
  return () => window.removeEventListener(EVENT, listener)
}

/** 会话页(不在渲染里):这个对话的摘要;壳还没告诉过 = null,壳的列表里没有它 = 没有过消息、不知道名字。 */
export function readChatSummary(chatId: string): ChatSummary | null {
  const summaries = read()
  return summaries ? (summaries.get(chatId) ?? { unreadCount: 0, isMarkedUnread: false, hasMessages: false, name: null, kind: null, lastMessagePreview: null, sourceChatId: null }) : null
}

/** 会话页:这个对话有没有过消息;壳还没告诉过 = null(还不知道,❌ 当成没有)。 */
export function useChatHasMessages(chatId: string | undefined): boolean | null {
  return useSyncExternalStore(subscribeChatSummaries, () => (chatId ? (readChatSummary(chatId)?.hasMessages ?? null) : null), () => null)
}

/** 会话页:壳那边全部对话的摘要(⌘K 面板搜对话和话题);壳还没告诉过 = 空。 */
export function useChatSummaries(): Summaries {
  return useSyncExternalStore(subscribeChatSummaries, () => read() ?? NO_SUMMARIES, () => NO_SUMMARIES)
}

const NO_SUMMARIES: Summaries = new Map()

export type ContactSummary = { id: string; name: string }
const CONTACT_KEY = '__GUGU_CONTACT_SUMMARIES__'
const NO_CONTACTS: readonly ContactSummary[] = []
export function publishContactSummaries(contacts: readonly ContactSummary[]): void {
  (window as unknown as Record<string, unknown>)[CONTACT_KEY] = contacts
  window.dispatchEvent(new Event(EVENT))
}
export function useContactSummaries(): readonly ContactSummary[] {
  return useSyncExternalStore(subscribeChatSummaries,
    () => (window as unknown as Record<string, unknown>)[CONTACT_KEY] as readonly ContactSummary[] ?? NO_CONTACTS,
    () => NO_CONTACTS)
}
