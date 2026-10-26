import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { installShellSlots, PROJECT_TOPICS_SLOT_PREFIX, readShellSlots } from '../lib/shellSlots'
import { useProjectGroupChats } from '../lib/projectGroupChatsBridge'
import { CHAT_LIST_SLOT_KEY, publishSidebarChatSignals, sidebarChatSignals, useSidebarChatView } from '../lib/sidebarChatsBridge'
import { useChatStore } from '../store/chatContext'
import { ChatListPanel, TopicSubRow, TopicSubRows } from './ChatListPanel'
import { compareChatsByActivityDesc, isSunkTopic } from '@gugu/core/shared/ui/chatModels'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { splitSunkTopics } from './chatListTopicNesting'
import { nextChatId } from './chat-list-keyboard-nav'
import { readSessionpageViewRequestBridge } from '../lib/sessionpageViewRequestBridge'
import { requestTopicSplit } from '../lib/topicSplitRequest'
import { useTabsReading } from './appSlot/useTabsReading'
import { topicTabOf } from '../session/renderer/features/chats/chat-tabs/chat-layouts'

installShellSlots()

const EMPTY: ReadonlyMap<string, HTMLElement> = new Map()

/**
 * 聊天列表画进会话页侧栏「对话」那一格(gugu-dev#181):行就是聊天列表那一行原样搬过来,所以画它的仍是 ChatListPanel
 * (`placement="sidebar"`),❌ 在会话页里另写一份行。侧栏两枚页签上的未读数也从这里发过去 —— 不管「对话」那一格挂没挂着。
 */
export function ChatListSlotHost() {
  const { chats } = useChatStore('chats')
  const projectGroupChats = useProjectGroupChats()
  useEffect(() => {
    publishSidebarChatSignals(sidebarChatSignals(chats, projectGroupChats))
  }, [chats, projectGroupChats])
  const slots = readShellSlots()
  const targets = useSyncExternalStore(
    (listener) => slots?.subscribeSlots(listener) ?? (() => undefined),
    () => slots?.getSlots() ?? EMPTY,
  )
  return [...targets].map(([key, element]) => {
    if (key === CHAT_LIST_SLOT_KEY) return createPortal(<ChatListPanel placement="sidebar" />, element, key)
    if (key.startsWith(PROJECT_TOPICS_SLOT_PREFIX)) return createPortal(<ProjectTopics sourceChatId={key.slice(PROJECT_TOPICS_SLOT_PREFIX.length)} />, element, key)
    return null
  })
}

/** Project topics use the conversation list's rows, ordering, disclosure and read path. */
export function ProjectTopics({ sourceChatId }: { sourceChatId: string }) {
  const { chats, pinChat, deleteChat, setChatNotificationLevel } = useChatStore('chats', 'pinChat', 'deleteChat', 'setChatNotificationLevel')
  const [expanded, setExpanded] = useState(false)
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const list = useRef<HTMLDivElement>(null)
  const focusedChat = useSidebarChatView().focusedChatId
  const activeTopic = useTabsReading(() => { const tab = topicTabOf(sourceChatId); return tab ? { chatId: tab.topic.topicChatId, shown: tab.shown } : null }, [sourceChatId])
  const topics = chats.filter((chat) => chat.kind === 'topic' && chat.source_chat_id === sourceChatId).sort(compareChatsByActivityDesc)
  const isSunk = (topic: ChatItem) => isSunkTopic(topic, Date.now()) && topic.id !== activeTopic?.chatId
  const { live } = splitSunkTopics(topics, isSunk, undefined, expanded)
  const open = (topic: ChatItem, beside = false) => {
    const sessionPage = readSessionpageViewRequestBridge()
    if (!sessionPage) throw new Error('sessionpage view request bridge is not installed')
    sessionPage.openChat(sourceChatId, beside)
    requestTopicSplit({ chatId: topic.id, name: topic.name ?? '', sourceChatId, focusComposer: true })
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>, topic: ChatItem) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      open(topic, event.metaKey || event.ctrlKey)
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      const ids = live.map((row) => row.id)
      const id = event.key === 'Home' ? ids[0] : event.key === 'End' ? ids.at(-1) : nextChatId(ids, topic.id, event.key === 'ArrowDown' ? 1 : -1)
      const target = Array.from(list.current?.querySelectorAll<HTMLElement>('[data-topic-subrow]') ?? []).find((row) => row.dataset.topicSubrow === id)
      target?.focus()
    }
  }
  if (topics.length === 0) return null
  return (
    <div ref={list} role="listbox" aria-label={chats.find((chat) => chat.id === sourceChatId)?.name ?? ''} onKeyDown={(event) => event.stopPropagation()}>
      <TopicSubRows topics={topics} isSunk={isSunk} expanded={expanded} onExpand={() => setExpanded(true)}>
        {(topic) => <TopicSubRow key={topic.id} topic={topic} mobile={false} isActive={focusedChat === sourceChatId && activeTopic?.shown === true && activeTopic.chatId === topic.id}
          tabIndex={focusedId === topic.id || (!focusedId && live[0]?.id === topic.id) ? 0 : -1}
          onClick={(event) => open(topic, event.metaKey || event.ctrlKey)} onFocus={() => setFocusedId(topic.id)} onKeyDown={(event) => onKeyDown(event, topic)}
          onPin={() => pinChat(topic.id, !topic.is_pinned)} onSetNotificationLevel={(level) => setChatNotificationLevel(topic.id, level)} onDelete={() => deleteChat(topic.id, true)} />}
      </TopicSubRows>
    </div>
  )
}
