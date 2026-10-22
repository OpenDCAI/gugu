import { useEffect, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { SidebarTab } from '@gugu/core/shared/enums/sidebarTabModels'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { installShellSlots, readShellSlots } from '../lib/shellSlots'
import { useProjectGroupChats } from '../lib/projectGroupChatsBridge'
import { CHAT_LIST_SLOT_KEY, publishSidebarChatSignals, type SidebarChatSignals } from '../lib/sidebarChatsBridge'
import { useChatStore } from '../store/chatContext'
import { ChatListPanel } from './ChatListPanel'

installShellSlots()

/**
 * 项目群(及从它开出来的话题)的未读记在那个群名下,其余记进「对话」;免打扰的不算(gugu-dev#181:
 * 「对话」页签挂对话那边的未读总数,项目行与「项目」页签挂项目群的未读)。只读未读数,真读了它自己会减。
 */
export function sidebarChatSignals(chats: readonly ChatItem[], projectGroupChats: ReadonlySet<string>): SidebarChatSignals {
  let chatsUnread = 0
  const groupUnread = new Map<string, number>()
  for (const chat of chats) {
    if (chat.unread_count <= 0 || chat.is_muted) continue
    const line = chat.kind === 'topic' ? (chat.source_chat_id ?? chat.id) : chat.id
    if (projectGroupChats.has(line)) groupUnread.set(line, (groupUnread.get(line) ?? 0) + chat.unread_count)
    else chatsUnread += chat.unread_count
  }
  return { chatsUnread, groupUnread }
}

const EMPTY: ReadonlyMap<string, HTMLElement> = new Map()

/**
 * 聊天列表画进会话页侧栏「对话」那一格(gugu-dev#181):行就是聊天列表那一行原样搬过来,所以画它的仍是 ChatListPanel
 * (`placement="sidebar"`),❌ 在会话页里另写一份行。侧栏两枚页签上的未读数也从这里发过去 —— 不管「对话」那一格挂没挂着。
 */
export function ChatListSlotHost({ activeTab }: { activeTab: SidebarTab }) {
  const { chats } = useChatStore('chats')
  const projectGroupChats = useProjectGroupChats()
  useEffect(() => {
    publishSidebarChatSignals(sidebarChatSignals(chats, projectGroupChats))
  }, [chats, projectGroupChats])
  const slots = readShellSlots()
  const element = useSyncExternalStore(
    (listener) => slots?.subscribeSlots(listener) ?? (() => undefined),
    () => (slots?.getSlots() ?? EMPTY).get(CHAT_LIST_SLOT_KEY) ?? null,
  )
  return element ? createPortal(<ChatListPanel activeTab={activeTab} placement="sidebar" />, element, CHAT_LIST_SLOT_KEY) : null
}
