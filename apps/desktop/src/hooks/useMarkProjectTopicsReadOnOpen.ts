import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { unreadForYou } from '@gugu/core/shared/ui/chatModels'
import { CHAT_SLOT_PREFIX } from '../lib/shellSlots'
import { markChatsReadAndRefresh } from '../lib/chatUnreadLocator'
import { rendererLogger } from '../lib/log'
import { useChatStore } from '../store/chatContext'

const log = rendererLogger('chat/project-topics-read')

/**
 * #1057 看过项目群,项目行就清零(owner 2026-10-30「我看这个群也看了，你为啥不把我的提醒给消掉呢」):项目行除了群主线,还数
 * 从它开出去的话题里叫到你的(sidebarChatsBridge)。主线是消息进视口逐条读掉的;话题各是一条线,不点开就一直挂在项目行上。
 * 所以打开项目群的那一刻,把这些话题一起读到最新。你自己标的未读不动。
 */
export function topicsReadOnOpen(chats: readonly ChatItem[], groupId: string): ChatItem[] {
  return chats.filter((chat) => chat.kind === 'topic' && chat.source_chat_id === groupId && !chat.is_marked_unread && unreadForYou(chat) > 0)
}

/** 一个项目群摆到眼前(从看不见变成看得见)读一次;一直开着不再读,收起再打开算又一次。 */
export function useMarkTopicsReadWhenShown(
  shown: ReadonlySet<string>,
  chats: readonly ChatItem[],
  chatsRead: boolean,
  markRead: (topics: ChatItem[]) => void,
): void {
  const handled = useRef(new Set<string>())
  const chatsRef = useRef(chats)
  chatsRef.current = chats
  useEffect(() => {
    for (const id of handled.current) if (!shown.has(id)) handled.current.delete(id)
    // 列表还没读到 = 还不知道话题有哪些:先不算这一次打开,读到了再读。
    if (!chatsRead) return
    for (const id of shown) {
      if (handled.current.has(id)) continue
      handled.current.add(id)
      const topics = topicsReadOnOpen(chatsRef.current, id)
      if (topics.length > 0) markRead(topics)
    }
  }, [shown, chatsRead, markRead])
}

/** 壳画进会话页的那些格子里,哪几个项目群此刻在视口里(块藏在背后、页签没选中都不算)。 */
function useShownProjectGroups(entries: ReadonlyMap<string, HTMLElement>, projectGroupChats: ReadonlySet<string>): ReadonlySet<string> {
  const [shown, setShown] = useState<ReadonlySet<string>>(() => new Set())
  useEffect(() => {
    const slots = [...entries].filter(([key]) => key.startsWith(CHAT_SLOT_PREFIX) && projectGroupChats.has(key.slice(CHAT_SLOT_PREFIX.length)))
    if (slots.length === 0) { setShown((current) => (current.size ? new Set() : current)); return }
    const idOf = new Map(slots.map(([key, element]) => [element, key.slice(CHAT_SLOT_PREFIX.length)]))
    const visible = new Set<string>()
    const observer = new IntersectionObserver((records) => {
      for (const record of records) {
        const id = idOf.get(record.target as HTMLElement)
        if (id === undefined) continue
        if (record.isIntersecting) visible.add(id)
        else visible.delete(id)
      }
      setShown(new Set(visible))
    })
    for (const element of idOf.keys()) observer.observe(element)
    return () => observer.disconnect()
  }, [entries, projectGroupChats])
  return shown
}

/** 会话页里的项目群(ChatSlotHost 画的那些格子):打开时把它开出去、叫到你的话题一起标已读。失败只记日志 —— 下次打开再读。 */
export function useMarkProjectTopicsReadOnOpen(entries: ReadonlyMap<string, HTMLElement>, projectGroupChats: ReadonlySet<string>): void {
  const { chats, chatsRead, refreshChats } = useChatStore('chats', 'chatsRead', 'refreshChats')
  const shown = useShownProjectGroups(entries, projectGroupChats)
  const markRead = useCallback((topics: ChatItem[]) => {
    void markChatsReadAndRefresh({ chats: topics, refresh: refreshChats })
      .then(({ failedChats, error }) => {
        if (failedChats > 0) log.error({ error: String(error), failedChats }, 'mark project topics read partially failed')
      })
      .catch((error: unknown) => log.error({ error: String(error) }, 'mark project topics read failed'))
  }, [refreshChats])
  useMarkTopicsReadWhenShown(shown, chats, chatsRead, markRead)
}
