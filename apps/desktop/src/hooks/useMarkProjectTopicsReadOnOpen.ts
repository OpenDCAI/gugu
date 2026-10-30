import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { unreadForYou } from '@gugu/core/shared/ui/chatModels'
import { CHAT_SLOT_PREFIX } from '../lib/shellSlots'
import { markChatsReadAndRefresh } from '../lib/chatUnreadLocator'
import { rendererLogger } from '../lib/log'
import { useChatStore } from '../store/chatContext'
import { readChatRows } from '../lib/imRepository'
import { isAppActive, useAppActive } from '../lib/onScreenChat'

const log = rendererLogger('chat/project-topics-read')

/**
 * #1057 看过项目群,项目行就清零(owner 2026-10-30「我看这个群也看了，你为啥不把我的提醒给消掉呢」):项目行除了群主线,还数
 * 从它开出去的话题里叫到你的(sidebarChatsBridge)。主线是消息进视口逐条读掉的;话题各是一条线,不点开就一直挂在项目行上。
 * 所以打开项目群的那一刻,把这些话题一起读到最新。你自己标的未读不动。
 */
export function topicsReadOnOpen(chats: readonly ChatItem[], groupId: string): ChatItem[] {
  return chats.filter((chat) => chat.kind === 'topic' && chat.source_chat_id === groupId && !chat.is_marked_unread && unreadForYou(chat) > 0)
}

type Opening = { chats?: ChatItem[]; handled: boolean }

/** 每次打开取一次权威快照,后台到达的结果留到前台。快照以后的消息不进入本次水位。 */
function useReadTopicsOnOpening(
  shown: ReadonlySet<string>,
  active: boolean,
  readChats: () => Promise<ChatItem[]>,
  markRead: (topics: ChatItem[]) => void,
): void {
  const openings = useRef(new Map<string, Opening>())
  const shownRef = useRef(shown)
  shownRef.current = shown
  const flush = useCallback((id: string, opening: Opening) => {
    if (openings.current.get(id) !== opening || opening.handled || !opening.chats || !shownRef.current.has(id) || !isAppActive()) return
    opening.handled = true
    const topics = topicsReadOnOpen(opening.chats, id)
    if (topics.length > 0) markRead(topics)
  }, [markRead])
  // 换号(读端换身份)或卸载后,旧请求的结果没有资格写已读。
  useEffect(() => () => openings.current.clear(), [readChats])
  useEffect(() => {
    for (const id of openings.current.keys()) if (!shown.has(id)) openings.current.delete(id)
    if (!active) return
    for (const id of shown) {
      const pending = openings.current.get(id)
      if (pending) { flush(id, pending); continue }
      const opening: Opening = { handled: false }
      openings.current.set(id, opening)
      void readChats().then((chats) => { opening.chats = chats; flush(id, opening) }).catch((error: unknown) => {
        opening.handled = true // 失败留到下次打开重试,不因列表更新反复触发。
        log.error({ error: String(error), groupId: id }, 'refresh project topics on open failed')
      })
    }
  }, [shown, active, readChats, flush])
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
        if (record.isIntersecting && record.intersectionRatio > 0) visible.add(id)
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
  const { refreshChats, getImRepository } = useChatStore('refreshChats', 'getImRepository')
  const shown = useShownProjectGroups(entries, projectGroupChats)
  const active = useAppActive()
  const readChats = useMemo(() => {
    let inFlight: Promise<ChatItem[]> | null = null
    return () => {
      if (inFlight) return inFlight
      const request = (async () => {
        const repository = await getImRepository()
        // chatsRead 可能只是缓存已可展示。refresh 成功后权威投影已落进同一 repository,
        // 立即读那份快照,不等 React 下一帧,也不另开一条会话列表拉取路。
        await refreshChats({ acceptEmpty: true, throwOnError: true })
        return readChatRows(repository)
      })()
      inFlight = request
      const clear = () => { if (inFlight === request) inFlight = null }
      void request.then(clear, clear)
      return request
    }
  }, [refreshChats, getImRepository])
  const markRead = useCallback((topics: ChatItem[]) => {
    void markChatsReadAndRefresh({ chats: topics, refresh: refreshChats })
      .then(({ failedChats, error }) => {
        if (failedChats > 0) log.error({ error: String(error), failedChats }, 'mark project topics read partially failed')
      })
      .catch((error: unknown) => log.error({ error: String(error) }, 'mark project topics read failed'))
  }, [refreshChats])
  useReadTopicsOnOpening(shown, active, readChats, markRead)
}
