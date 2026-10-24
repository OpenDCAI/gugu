import { useEffect, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { SidebarTab } from '@gugu/core/shared/enums/sidebarTabModels'
import { installShellSlots, readShellSlots } from '../lib/shellSlots'
import { useProjectGroupChats } from '../lib/projectGroupChatsBridge'
import { CHAT_LIST_SLOT_KEY, publishSidebarChatSignals, sidebarChatSignals } from '../lib/sidebarChatsBridge'
import { useChatStore } from '../store/chatContext'
import { ChatListPanel } from './ChatListPanel'

installShellSlots()

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
