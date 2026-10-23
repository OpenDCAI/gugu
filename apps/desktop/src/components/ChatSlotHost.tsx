import { useEffect, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { CHAT_SLOT_PREFIX, InChatSlot, chatPartSlotKey, installShellSlots, readShellSlots } from '../lib/shellSlots'
import { ChatAreaPanel } from './ChatAreaPanel'
import { TaskChatScope } from './assistant/TaskChatScope'
import type { AssistantChatHandlers } from './assistant/AssistantChatSlot'
import { publishChatSummaries } from '../lib/chatSummariesBridge'
import { useChatStore } from '../store/chatContext'
import { chatDisplayName } from '@gugu/core/shared/ui/chatModels'
import { useProjectGroupChats } from '../lib/projectGroupChatsBridge'

installShellSlots()

const EMPTY: ReadonlyMap<string, HTMLElement> = new Map()

/**
 * 把对话画进会话页留的格子(gugu-dev#181:项目块的第一枚页签是项目群,对话也是一块)。和对话页同一个群聊组件,
 * 话题、置顶、悄悄话、回应都是现成的;每个格子各是一条活的线(TaskChatScope),和对话页正开着的那条互不挤占。
 * 块里没有群聊头:头上那排图标、对话的头像和名字、开着的话题画进这一块页签条上留的几格(chatPartSlotKey)。
 */
export function ChatSlotHost(handlers: AssistantChatHandlers) {
  // 会话页据此决定项目块正中摆文件夹卡(群里还没有消息)还是消息流,会话里「来自 X」写群名。列表读成之前那份空列表是
  // 「还不知道」:不发,❌ 发一份空的让每个项目块先画首页。
  // 名字与对话列表那一行同一个函数(chatDisplayName):私聊没有自己的名字,写对方(备注优先)——列表、⌘K 面板、
  // 「来自 X」三处叫法一样。
  const { chats, chatsRead, identitiesById } = useChatStore('chats', 'chatsRead', 'identitiesById')
  useEffect(() => {
    if (chatsRead) publishChatSummaries(chats.map((chat) => ({ ...chat, name: chatDisplayName(chat, identitiesById[chat.peer_user_id ?? '']?.display_name) })))
  }, [chats, chatsRead, identitiesById])
  const projectGroupChats = useProjectGroupChats()
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
          <InChatSlot.Provider value={{ projectName: projectGroupChats.has(chatId) ? chats.find((chat) => chat.id === chatId)?.name ?? null : null }}>
            <TaskChatScope chatId={chatId}>
              <ChatAreaPanel
                chatId={chatId}
                activeTab="chats"
                blockHost={{
                  actions: entries.get(chatPartSlotKey('actions', chatId)) ?? null,
                  title: entries.get(chatPartSlotKey('title', chatId)) ?? null,
                  tabs: entries.get(chatPartSlotKey('tabs', chatId)) ?? null,
                }}
                {...handlers}
              />
            </TaskChatScope>
          </InChatSlot.Provider>,
          element,
          key,
        )]
      })}
    </>
  )
}
