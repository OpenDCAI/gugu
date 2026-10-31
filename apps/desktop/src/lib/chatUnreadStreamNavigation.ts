import { useCallback, useEffect, useRef, useState, type MutableRefObject, type SetStateAction } from 'react'
import type { ChatItem, ChatUnreadLocator, MessageItem } from '@gugu/core/shared/types/chat'
import { mergeMessagesById } from '@gugu/core/shared/ui/messageListModels'
import { cloudReadTarget, writeRead } from './readWriter'
import {
  openStreamAtLocator as runOpenStreamAtLocator,
  requestUnreadMessageReveal,
  type OpenableUnreadTarget,
  type CapturedUnreadEntry,
} from './chatUnreadLocator'
import { getUnreadLocatorWindow } from './chatUnreadLocatorMessages'
import {
  commitUnreadLocatorWindow,
  selectRetainedStreamRows,
  type UnreadLocatorCommit,
} from './chatUnreadLocatorWindow'

type User = { id: string }
type CancelChatOpenRef = MutableRefObject<(chatId: string, error: Error) => void>

type Deps = {
  user: User | null
  chatsRef: MutableRefObject<ChatItem[]>
  activeChatIdRef: MutableRefObject<string | null>
  isChatOpen: (chatId: string) => boolean
  threadRootOf: (chatId: string) => string | null
  getMessageSnapshotEpoch: (chatId: string) => number
  setActiveChatId: (chatId: string) => void
  setActiveThreadRootId: (rootId: string | null, chatId: string) => void
  setLoadingThread: (loading: boolean, chatId: string) => void
  setThreadMessages: (value: SetStateAction<MessageItem[]>, chatId: string) => void
  loadChats: (options?: { acceptEmpty?: boolean }) => Promise<void>
  cancelChatOpenRef: CancelChatOpenRef
}

export function useChatUnreadStreamNavigation(deps: Deps) {
  const { getMessageSnapshotEpoch } = deps
  const chatOpenInFlightRef = useRef(new Set<string>())
  const chatOpenWaitersRef = useRef(new Map<string, Set<{ resolve: () => void; reject: (error: Error) => void }>>())
  const locatorNavigationRef = useRef(new Map<HTMLElement | 'primary', OpenableUnreadTarget & { epoch: number }>())
  const [unreadEntries, setUnreadEntries] = useState<Record<string, CapturedUnreadEntry & { epoch: number }>>({})
  useEffect(() => () => { locatorNavigationRef.current.clear() }, [deps.user?.id])

  const consumeUnreadEntry = useCallback((chatId: string, locator: ChatUnreadLocator) => {
    setUnreadEntries((previous) => {
      if (previous[chatId]?.locator !== locator) return previous
      const { [chatId]: _consumed, ...remaining } = previous
      return remaining
    })
  }, [])

  const settleChatOpen = useCallback((chatId: string, error?: Error) => {
    const waiters = chatOpenWaitersRef.current.get(chatId)
    if (!waiters) return
    chatOpenWaitersRef.current.delete(chatId)
    for (const waiter of waiters) error ? waiter.reject(error) : waiter.resolve()
  }, [])

  const waitForChatOpen = useCallback((chatId: string): Promise<void> => new Promise((resolve, reject) => {
    const waiters = chatOpenWaitersRef.current.get(chatId) ?? new Set()
    waiters.add({ resolve, reject })
    chatOpenWaitersRef.current.set(chatId, waiters)
  }), [chatOpenWaitersRef])

  const ownsChat = useCallback((chatId: string) => {
    return [...locatorNavigationRef.current.values()].some((target) => target.chatId === chatId && target.epoch === getMessageSnapshotEpoch(chatId))
  }, [getMessageSnapshotEpoch])
  const ownsThread = useCallback((chatId: string, rootId: string) =>
    [...locatorNavigationRef.current.values()].some((target) => target.chatId === chatId && target.epoch === getMessageSnapshotEpoch(chatId)
      && target.locator.stream_kind === 'thread' && target.locator.thread_root_id === rootId), [getMessageSnapshotEpoch])

  const openStreamAtLocator = useCallback(async (chatId: string, saved?: ChatUnreadLocator, viewport?: HTMLElement | null): Promise<void> => {
    const locator = saved ?? deps.chatsRef.current.find((chat) => chat.id === chatId)?.unread_locator
    if (!locator) {
      deps.setActiveChatId(chatId)
      return
    }
    if (!locator.message_id || locator.message_seq == null) {
      throw new Error(`Unread stream ${locator.stream_id} has no openable message locator`)
    }
    const target = { chatId, epoch: deps.getMessageSnapshotEpoch(chatId), locator: { ...locator, message_id: locator.message_id, message_seq: locator.message_seq } }
    const viewportTarget = viewport ?? 'primary'
    locatorNavigationRef.current.set(viewportTarget, target)
    let threadActivated = false
    const isCurrent = () => locatorNavigationRef.current.get(viewportTarget) === target
      && deps.getMessageSnapshotEpoch(chatId) === target.epoch
      && deps.isChatOpen(chatId)
      && (!threadActivated || deps.threadRootOf(chatId) === target.locator.thread_root_id)
    const assertCurrent = () => {
      if (!isCurrent()) throw new DOMException('Unread navigation was superseded', 'AbortError')
    }
    try {
      await runOpenStreamAtLocator(target, {
        activateChat: async (targetChatId) => {
          if (!viewport) deps.setActiveChatId(targetChatId)
          if (deps.isChatOpen(targetChatId) && !chatOpenInFlightRef.current.has(targetChatId)) return
          const ready = waitForChatOpen(targetChatId)
          await ready
        },
        ensureMessageLoaded: async (currentTarget) => {
          assertCurrent()
          const userId = deps.user?.id
          if (!userId) throw new Error('Cannot open unread locator without an account')
          // @@@4258 — 锚点两侧各取一页：锚点页给上文与锚点本身，forward 页把窗口延伸到 stream 尾部。
          // 只取锚点页会让行集停在第一条未读，而水位随后越过它 → badge 少一、消息不可见（消息区没有
          // 「加载更新」入口，只能切走再切回才刷回来）。够没够到尾部由 forward 页的填充结果判定。
          const loadWindow = async (): Promise<UnreadLocatorCommit> => {
            const pages = await getUnreadLocatorWindow(currentTarget.chatId, currentTarget.locator, userId)
            return commitUnreadLocatorWindow({ anchorSeq: currentTarget.locator.message_seq, ...pages })
          }
          // 保留既有行时按 locator 的 stream 归属过滤：thread 视图是一个扁平数组，而这条路**不经过
          // openThread**（那里才有 setThreadMessages([]) 的清空），跨 root 保留会把上一个话题的回复混进来。
          const retain = (previous: readonly MessageItem[], commit: UnreadLocatorCommit) =>
            selectRetainedStreamRows(previous, commit, currentTarget.locator)
          if (currentTarget.locator.stream_kind === 'thread') {
            const rootId = currentTarget.locator.thread_root_id
            if (!rootId) throw new Error(`Thread locator ${currentTarget.locator.stream_id} has no root`)
            threadActivated = true
            deps.setActiveThreadRootId(rootId, currentTarget.chatId)
            deps.setLoadingThread(true, currentTarget.chatId)
            try {
              const commit = await loadWindow()
              assertCurrent()
              deps.setThreadMessages((previous) => mergeMessagesById(retain(previous, commit), commit.rows, currentTarget.chatId), currentTarget.chatId)
              return commit
            } finally {
              if (isCurrent()) deps.setLoadingThread(false, currentTarget.chatId)
            }
          }
          const commit = await loadWindow()
          assertCurrent()
          return commit
        },
        revealMessage: async (currentTarget, commit) => {
          assertCurrent()
          await requestUnreadMessageReveal(currentTarget, isCurrent, viewport, commit)
          // A confirmed entry is consumed before the read RPC: it must not discard a later reading anchor.
          if (saved) consumeUnreadEntry(chatId, saved)
        },
        markRead: async (currentTarget, commit) => { assertCurrent(); await writeRead(cloudReadTarget(currentTarget.chatId, currentTarget.locator.thread_root_id, commit.readSeq)) },
        refreshChats: () => { assertCurrent(); return deps.loadChats({ acceptEmpty: true }) },
      })
    } catch (error) {
      // Switching chat or choosing the latest window cancels this navigation. A
      // failure in the still-current navigation remains visible to the caller.
      if (isCurrent()) throw error
    } finally {
      if (locatorNavigationRef.current.get(viewportTarget) === target) locatorNavigationRef.current.delete(viewportTarget)
    }
  }, [deps, waitForChatOpen, consumeUnreadEntry])

  // @@@6530 微信式打开:有未读的会话也停在最新处,与已读会话同一条路(尾部对账落定时水位提交到尾、角标清零)。
  // 第一条未读只记下来给「↑ N 条新消息」,点了才走上面的定位;话题流未读、当前会话再点仍直接定位。
  const captureUnreadEntry = useCallback((chatId: string) => {
    const locator = deps.chatsRef.current.find((chat) => chat.id === chatId)?.unread_locator
    if (locator?.message_id && locator.message_seq != null) {
      const saved = { ...locator, message_id: locator.message_id, message_seq: locator.message_seq }
      const entry = { chatId, epoch: getMessageSnapshotEpoch(chatId), locator: saved, onSeen: () => consumeUnreadEntry(chatId, saved) }
      setUnreadEntries((previous) => ({ ...previous, [chatId]: entry }))
    }
  }, [deps.chatsRef, getMessageSnapshotEpoch, consumeUnreadEntry])
  const openUnreadChat = useCallback(async (chatId: string, alreadyOpen = deps.activeChatIdRef.current === chatId): Promise<void> => {
    const locator = deps.chatsRef.current.find((chat) => chat.id === chatId)?.unread_locator
    if (locator && (locator.stream_kind === 'thread' || alreadyOpen)) return openStreamAtLocator(chatId)
    captureUnreadEntry(chatId)
    deps.setActiveChatId(chatId)
  }, [deps, captureUnreadEntry, openStreamAtLocator])
  // 离开这个会话、或它的窗口被换掉(点了标签跳过去、回到最新页)都作废:epoch 与 ownsChat 同一把尺子。
  const entryFor = useCallback((chatId: string | null) => {
    const entry = chatId ? unreadEntries[chatId] : null
    return entry && entry.epoch === getMessageSnapshotEpoch(entry.chatId) ? entry : null
  }, [unreadEntries, getMessageSnapshotEpoch])
  const entry = entryFor(deps.activeChatIdRef.current)
  const jumpRef = useRef<(chatId?: string | null, viewport?: HTMLElement | null) => Promise<void>>(() => Promise.resolve())
  jumpRef.current = (chatId = deps.activeChatIdRef.current, viewport) => {
    const target = entryFor(chatId)
    return target ? openStreamAtLocator(target.chatId, target.locator, viewport) : Promise.resolve()
  }
  const jumpToUnreadEntry = useCallback((chatId?: string | null, viewport?: HTMLElement | null) => jumpRef.current(chatId, viewport), [])

  const beginChatOpen = useCallback((chatId: string) => {
    chatOpenInFlightRef.current.add(chatId)
    captureUnreadEntry(chatId)
  }, [captureUnreadEntry])
  const finishChatOpen = useCallback((chatId: string, error?: Error) => {
    chatOpenInFlightRef.current.delete(chatId)
    settleChatOpen(chatId, error)
  }, [settleChatOpen])
  const cancelChatOpen = useCallback((chatId: string, error: Error) => {
    chatOpenInFlightRef.current.delete(chatId)
    settleChatOpen(chatId, error)
  }, [settleChatOpen])
  deps.cancelChatOpenRef.current = cancelChatOpen

  return {
    ownsChat,
    ownsThread,
    openStreamAtLocator,
    openUnreadChat, unreadEntry: entry, entryFor, jumpToUnreadEntry,
    beginChatOpen,
    finishChatOpen,
    cancelChatOpen,
  }
}
