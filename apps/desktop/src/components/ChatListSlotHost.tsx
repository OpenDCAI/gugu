import { useEffect, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { installShellSlots, readShellSlots } from '../lib/shellSlots'
import { useProjectGroupChats } from '../lib/projectGroupChatsBridge'
import { subscribeShellChatActions, takeShellChatAction, type ShellChatAction, CHAT_LIST_SLOT_KEY, publishSidebarChatSignals, sidebarChatSignals } from '../lib/sidebarChatsBridge'
import { useChatStore } from '../store/chatContext'
import { ChatListPanel } from './ChatListPanel'
import { useMarkChatsRead } from '../hooks/useMarkChatsRead'
import { useAssistantShell } from '../session/renderer/features/assistant/assistant-shell'

installShellSlots()

const EMPTY: ReadonlyMap<string, HTMLElement> = new Map()

/**
 * 聊天列表画进会话页侧栏「对话」那一格(gugu-dev#181):行就是聊天列表那一行原样搬过来,所以画它的仍是 ChatListPanel
 * (`placement="sidebar"`),❌ 在会话页里另写一份行。侧栏两枚页签上的未读数也从这里发过去 —— 不管「对话」那一格挂没挂着。
 */
export function ChatListSlotHost() {
  const { chats } = useChatStore('chats')
  const markRead = useMarkChatsRead()
  useEffect(() => {
    const take = () => {
      const action = takeShellChatAction((value): value is Extract<ShellChatAction, { kind: 'mark-read' }> => typeof value === 'object' && value.kind === 'mark-read')
      if (action) markRead(action.chatId)
    }
    take()
    return subscribeShellChatActions(take)
  }, [markRead])
  const projectGroupChats = useProjectGroupChats()
  const assistant = useAssistantShell()
  useEffect(() => {
    publishSidebarChatSignals(sidebarChatSignals(chats, projectGroupChats, assistant))
  }, [chats, projectGroupChats, assistant])
  const slots = readShellSlots()
  const targets = useSyncExternalStore(
    (listener) => slots?.subscribeSlots(listener) ?? (() => undefined),
    () => slots?.getSlots() ?? EMPTY,
  )
  return [...targets].map(([key, element]) => {
    if (key === CHAT_LIST_SLOT_KEY) return createPortal(<ChatListPanel placement="sidebar" />, element, key)
    return null
  })
}
