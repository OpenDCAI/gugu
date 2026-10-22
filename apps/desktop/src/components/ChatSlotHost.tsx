import { useEffect, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { CHAT_SLOT_PREFIX, InChatSlot, installShellSlots, readShellSlots } from '../lib/shellSlots'
import { ChatAreaPanel } from './ChatAreaPanel'
import { TaskChatScope } from './assistant/TaskChatScope'
import type { AssistantChatHandlers } from './assistant/AssistantChatSlot'
import { publishChatsWithMessages } from '../lib/chatActivityBridge'
import { useChatStore } from '../store/chatContext'

installShellSlots()

const EMPTY: ReadonlyMap<string, HTMLElement> = new Map()

/**
 * 把对话画进会话页留的格子(gugu-dev#181:项目块的第一枚页签是项目群,对话也是一块)。和对话页同一个群聊组件,
 * 话题、置顶、悄悄话、回应都是现成的;每个格子各是一条活的线(TaskChatScope),和对话页正开着的那条互不挤占。
 */
export function ChatSlotHost(handlers: AssistantChatHandlers) {
  // 会话页据此决定项目块正中摆文件夹卡(群里还没有消息)还是消息流。列表读成之前那份空列表是「还不知道」:不发,
  // ❌ 发一个空集让每个项目块先画首页。
  const { chats, chatsRead } = useChatStore('chats', 'chatsRead')
  useEffect(() => {
    if (chatsRead) publishChatsWithMessages(chats.filter((chat) => chat.last_message_at).map((chat) => chat.id))
  }, [chats, chatsRead])
  const slots = readShellSlots()
  const entries = useSyncExternalStore(
    (listener) => slots?.subscribeSlots(listener) ?? (() => undefined),
    () => slots?.getSlots() ?? EMPTY,
  )
  return (
    <>
      {[...entries].flatMap(([key, element]) => {
        if (!key.startsWith(CHAT_SLOT_PREFIX)) return []
        const chatId = key.slice(CHAT_SLOT_PREFIX.length)
        return [createPortal(
          <InChatSlot.Provider value>
            <TaskChatScope chatId={chatId}>
              <ChatAreaPanel chatId={chatId} activeTab="chats" {...handlers} />
            </TaskChatScope>
          </InChatSlot.Provider>,
          element,
          key,
        )]
      })}
    </>
  )
}
