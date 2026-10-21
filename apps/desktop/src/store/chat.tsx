import { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo, useSyncExternalStore, type Dispatch, type SetStateAction } from 'react'
import { chatService } from '../lib/chat'
import { isLifecycleCancellation } from '../lib/authBoundedFetch'
import { useAuth } from './auth'
import { useToast, type ToastType } from '../components/toastContext'
import { upsertChatRow } from '@gugu/core/shared/ui/chatModels'
import { useGroupCreation } from './useGroupCreation'
import { mergeMessagesById, optimisticReplyFields, upsertMessageById } from '@gugu/core/shared/ui/messageListModels'
import { useNotificationSettings } from '../lib/notificationSettings'
import {
  openImRepository,
  imSelectors,
  replaceChatRows,
  type AccountImRepository,
} from '../lib/imRepository'
import { closeImRepository, publishMessageWindow, subscribeIdentities } from '../lib/chatMessageWindowPublication'
import { readCompleteCachedChats } from '../lib/chatSnapshotPublication'
import { createChatListProjectionLedger, useChatProjectionBinding } from './chatListProjection'
import { adoptOptimisticChatRow } from '../lib/optimisticChatIdentity'
import { decideColdStartFetch, deltaResultRequiresDegrade } from '../lib/coldStartFetch'
import { applyMessageWindowRevalidation } from '../lib/chatMessageRevalidation'
import { platform } from '../platform'
import { createOutboxWiring, type OutboxWiring } from './chatOutboxWiring'
import { markLatestThreadRead, markManualUnreadAndRefresh } from '../lib/chatUnreadLocator'
import { useChatUnreadStreamNavigation } from '../lib/chatUnreadStreamNavigation'
import { ChatStoreProvider, type SendMessageOptions, useDraftAttachmentsStore, useDraftMentionsStore, useTextDraftStore, type RefreshChatsOptions } from './chatContext'
import { advanceReadWatermark, applyThreadSnapshot, fetchOpenThreadSnapshot, patchChatRows, reconcileMemberReadSeqs, type PatchChat } from './chatRealtimeMutations'; import { subscribeChatLineRevisions } from '../lib/accountRevisionListeners'; import { useMemberReadSeqs } from '../hooks/useMemberReadSeqs'; import { chatOnScreen } from '../lib/onScreenChat'
import { useMessageReadFailures, useMessageSnapshotEpochs } from './chatMessageReads'
import { deriveThreadScope } from './threadScope'
import { useActiveChatTransitionState } from './activeChatTransition'; import { useChatWindowCache } from './chatWindowPublication'
import { ChatHistoryWindow } from './chatHistoryWindow'
import {
  INITIAL_PAGE,
  NEWER_PAGE,
  maxMainlineSeq,
  trimToMessageWindow,
} from './chatMessageWindow'
import { repairSeqJumpAfterIngest } from './chatSeqJumpRepair'
import { commitHealedMessages } from './chatHealCommit'
import { seedCacheFromDisk } from './chatDiskWindow'
import type { ChatItem, MessageItem, NotificationLevel } from '@gugu/core/shared/types/chat'
import {
  createAccountRevisionCoordinator,
  type AccountRevisionCoordinator,
  type AccountRevisionEvent,
  type AccountRevisionListener,
} from '../lib/accountRevisionCoordinator'
import { createSupabaseAccountRevisionSource } from '../lib/supabaseAccountRevisionSource'
import { refreshObservedAgentPresenceFromRevision } from '../lib/agentPresenceStore'
import { rendererLogger } from '../lib/log'

const revisionLog = rendererLogger('chat/account-revision')

export function ChatProvider({ children, active = true }: { children: React.ReactNode; active?: boolean }) {
  const { user: authenticatedUser } = useAuth(), user = active ? authenticatedUser : null
  const { toast } = useToast()
  const userId = user?.id ?? null
  const notificationSettings = useNotificationSettings()
  const [chats, setChats] = useState<ChatItem[]>([])
  const [identitiesById, setIdentitiesById] = useState<ReturnType<typeof imSelectors.identitiesById>>({})
  const [activeChatId, setActiveChatIdState] = useActiveChatTransitionState()
  const historyWindow = useMemo(() => new ChatHistoryWindow(userId), [userId])
  const messageWindow = useSyncExternalStore(historyWindow.subscribe, historyWindow.getSnapshot)
  useEffect(() => () => historyWindow.invalidate(), [historyWindow])
  const { messages, hasOlder: hasMoreOlder } = messageWindow
  const setMessages = historyWindow.update
  const setHasMoreOlder = historyWindow.setHasOlder
  const loadingOlder = messageWindow.loading === 'older'
  const [chatsLoad, setChatsLoad] = useState<'idle' | 'loading' | 'failed'>('idle') // failed = 最近一次列表读失败了(#2118:空着不是「没有」)
  const [loadingMessages, setLoadingMessages] = useState(false)
  const { track: trackMessageRead, noteFreshRead: noteFreshMessageRead, failureOf: messageReadFailureOf } = useMessageReadFailures() // #7199 读失败按会话、按最新一次读记
  const { memberReadSeqs, memberReadSeqsChatRef, setMemberReadSeqs, readMemberReadSeqs } = useMemberReadSeqs() // #6470 线级水位容器,与话题分栏同一个
  const { dropTextDraft, ...textDraftContext } = useTextDraftStore()
  const draftMentionContext = useDraftMentionsStore()
  // @@@draft-attachment (#1872) - per-chat queued-attachment store (state/set/get/drop live in the hook).
  const { dropDraftAttachments, ...draftAttachmentContext } = useDraftAttachmentsStore()
  // @@@threads (#957) — 话题态（附加层，不扰动主时间线机器）。摘要随会话切换加载；活动话题独立拉取。
  const [activeThreadRootId, setActiveThreadRootId] = useState<string | null>(null)
  const [threadMessages, setThreadMessages] = useState<MessageItem[]>([])
  const [loadingThread, setLoadingThread] = useState(false)
  const cancelChatOpenRef = useRef<(chatId: string, error: Error) => void>(() => undefined)
  const unreadNavigationRef = useRef<ReturnType<typeof useChatUnreadStreamNavigation> | null>(null)
  const activeThreadRootIdRef = useRef<string | null>(null)

  // ── SWR caches & ref-backed mirrors ─────────────────────────────────────────
  // messagesCacheRef: chatId → last-known messages. Read on setActiveChatId for
  // immediate paint; written through setMessagesAndCache on every mutation so
  // re-entry to a chat shows stale-while-revalidate content.
  const { cache, subscribeChatWindow } = useChatWindowCache()
  const messagesCacheRef = useRef(cache)
  // revalidateInFlightRef: chatIds whose background fetch is currently in flight.
  // Used by smoke pollUntilCacheHitRevalidated to wait for SWR completion.
  const revalidateInFlightRef = useRef<Set<string>>(new Set())
  const imRepositoryRef = useRef<AccountImRepository | null>(null)
  const imRepositoryPromiseRef = useRef<{ accountId: string; promise: Promise<AccountImRepository> } | null>(null)
  const revisionCoordinatorRef = useRef<AccountRevisionCoordinator | null>(null)
  const revisionCoordinatorPromiseRef = useRef<Promise<AccountRevisionCoordinator> | null>(null)
  const imRepositoryScope = useMemo(() => ({ accountId: userId, disposed: false }), [userId])
  const outboxRef = useRef<OutboxWiring | null>(null)
  // chatOpenSeqRef: monotonically bumped on every active-chat switch. The L2 read is async, so a late
  // return for a PREVIOUS chat must early-return at this seq guard — otherwise it could paint chat A's
  // window into the freshly-switched chat B (cross-chat bleed).
  const chatOpenSeqRef = useRef(0)
  // Ref mirrors of state — read by debug bridge (closure-captured at mount time).
  const activeChatIdRef = useRef<string | null>(null)
  const messagesRef = historyWindow.messagesRef
  const hasMoreOlderRef = useRef(false)
  const loadingMessagesRef = useRef<boolean>(false)
  // chatsRef: mirror of chats so loadChats can read length synchronously to
  // decide whether to flip loadingChats=true (only when list is empty / first load).
  const chatsRef = useRef<ChatItem[]>([])
  // #4314 列表投影账本：谁被哪一发看见过、哪些乐观行还没被投影出来。规则在 chatListProjection.ts。
  const projectionRef = useRef(createChatListProjectionLedger())
  const listRequestSeqRef = useRef(0)

  // Sync refs synchronously with state so debug bridge reads consistent values.
  useLayoutEffect(() => { activeChatIdRef.current = activeChatId }, [activeChatId])
  useLayoutEffect(() => {
    loadingMessagesRef.current = loadingMessages
  }, [loadingMessages])
  useLayoutEffect(() => {
    chatsRef.current = chats
  }, [chats])
  useLayoutEffect(() => {
    hasMoreOlderRef.current = hasMoreOlder
  }, [hasMoreOlder])

  const healCycleCountRef = useRef(0)
  // Install global debug bridge once. Closure captures refs (live values).
  useEffect(() => {
    window.__chatDebug = {
      getHealCycleCount: () => healCycleCountRef.current,
      getActiveChatId: () => activeChatIdRef.current,
      getMessagesCount: () => messagesRef.current.length,
      getLoadingMessages: () => loadingMessagesRef.current,
      getCachedChatIds: () => Array.from(messagesCacheRef.current.keys()),
      getMessagesCallCount: () =>
        Object.values(chatService._callCountsBySource).reduce((a, b) => a + b, 0),
      getCallCountsBySource: () => ({ ...chatService._callCountsBySource }),
      getRevalidateInFlight: () => Array.from(revalidateInFlightRef.current),
    }
  }, [messagesRef])

  const cacheHistoryWindow = useCallback(() => {
    const { chatId, messages } = historyWindow.getSnapshot()
    if (chatId) messagesCacheRef.current.set(chatId, messages)
  }, [historyWindow])
  // Merged write: setMessages + cache.set. Every mutation path goes through this
  // so the cache is always in lockstep with the rendered list.
  const setMessagesAndCache = useCallback(
    (
      updater: ((prev: MessageItem[]) => MessageItem[]) | MessageItem[],
      chatId: string | null,
    ) => {
      // @@@prev-bleed-root (#621 layer 2) - a write targeting a NON-active chat must derive
      // `prev` from THAT chat's own cache, not the global `messages` (which is the active
      // chat's). Without this, any async write for another chat poisoned its cache with the
      // active chat's content (the cross-chat bleed #803 layer-1 defended against — this
      // closes it at the source). We also must NOT touch global messages/messagesRef here:
      // they mirror the active chat, and re-rendering with another chat's data would paint it.
      const activeId = activeChatIdRef.current
      // activeId 为 null(启动期/未选会话)时同样走 cache 分支:此刻没有「活动会话」可画,
      // 写全局 messages 只会把不同会话的行(如 outbox 恢复注入)搅进同一数组并污染各自 L1(#1762 评审)。
      if (chatId && chatId !== activeId) {
        const prev = messagesCacheRef.current.get(chatId) ?? []
        const next =
          typeof updater === 'function'
            ? (updater as (p: MessageItem[]) => MessageItem[])(prev)
            : updater
        // @@@chat-isolation (guye #1) - non-active chat: always trim to the recent window (SWR
        // re-fetches on re-entry). This is the big memory chunk — trim hard.
        messagesCacheRef.current.set(chatId, trimToMessageWindow(next))
        return
      }
      historyWindow.update(updater)
      cacheHistoryWindow()
    },
    [cacheHistoryWindow, historyWindow],
  )

  const getImRepository = useCallback(async (): Promise<AccountImRepository> => {
    if (!user?.id) throw new Error('Cannot open IM repository without an account')
    if (imRepositoryScope.disposed || imRepositoryScope.accountId !== user.id) throw new Error(`IM repository scope ${user.id} disposed`)
    if (imRepositoryRef.current?.accountId === user.id) return imRepositoryRef.current
    if (imRepositoryPromiseRef.current?.accountId === user.id) return imRepositoryPromiseRef.current.promise
    const promise = openImRepository(user.id)
    imRepositoryPromiseRef.current = { accountId: user.id, promise }
    const repository = await promise
    if (imRepositoryScope.disposed || imRepositoryPromiseRef.current?.promise !== promise) {
      repository.close()
      throw new Error(`IM repository scope ${user.id} was disposed or superseded during open`)
    }
    imRepositoryRef.current = repository
    subscribeIdentities(repository, setIdentitiesById) // #6306 同一份身份也经 identityDirectoryBridge 送进会话页
    return repository
  }, [imRepositoryScope, user?.id])

  const getRevisionCoordinator = useCallback(async (): Promise<AccountRevisionCoordinator> => {
    if (revisionCoordinatorRef.current) return revisionCoordinatorRef.current
    if (revisionCoordinatorPromiseRef.current) return revisionCoordinatorPromiseRef.current
    const promise = getImRepository().then((repository) => {
      if (!user?.id || imRepositoryScope.disposed) throw new Error('Account revision scope disposed before start')
      const coordinator = createAccountRevisionCoordinator(
        user.id,
        repository,
        createSupabaseAccountRevisionSource(),
      )
      revisionCoordinatorRef.current = coordinator
      coordinator.start()
      return coordinator
    })
    revisionCoordinatorPromiseRef.current = promise
    try {
      return await promise
    } finally {
      if (revisionCoordinatorPromiseRef.current === promise) revisionCoordinatorPromiseRef.current = null
    }
  }, [getImRepository, imRepositoryScope, user?.id])

  const subscribeAccountRevision = useCallback((
    events: AccountRevisionEvent | readonly AccountRevisionEvent[],
    listener: AccountRevisionListener,
  ): (() => void) => {
    let active = true
    let unsubscribe: (() => void) | null = null
    void getRevisionCoordinator().then((coordinator) => {
      if (!active) return
      unsubscribe = coordinator.subscribe(events, listener)
    }).catch((error) => revisionLog.error({ error }, 'coordinator failed'))
    return () => {
      active = false
      unsubscribe?.()
    }
  }, [getRevisionCoordinator])
  useEffect(() => {
    imRepositoryScope.disposed = false // StrictMode replays setup; a real unmount has no re-arm.
    return () => {
      imRepositoryScope.disposed = true
      revisionCoordinatorRef.current?.stop()
      revisionCoordinatorRef.current = null
      revisionCoordinatorPromiseRef.current = null
      outboxRef.current?.dispose()
      const pending = imRepositoryPromiseRef.current
      imRepositoryPromiseRef.current = null
      void pending?.promise.then(closeImRepository, () => {})
      imRepositoryRef.current = null
    }
  }, [imRepositoryScope, userId])

  const persistWindowToLocalSync = useCallback(
    (chatId: string, messages: MessageItem[]): void => {
      const hasMoreOlder = activeChatIdRef.current === chatId ? hasMoreOlderRef.current : false
      void getImRepository()
        .then((repository) => publishMessageWindow(repository, chatId, messages, hasMoreOlder))
        .catch((err) => console.error('[ChatStore] persist repository message window failed', err))
    },
    [getImRepository],
  )

  // @@@send-outbox (#1762 洞③/#1941) — 发送 outbox 接线。io 依赖全经 outboxDepsRef 惰性委托:wiring
  // 单例首次 render 构造,而 patchChat 等定义在本文件更靠后(直接闭包会 TDZ)——
  // depsRef 在每次 render 末尾(provider return 前)刷新为最新身份,回调只在事件时刻解引用。
  // retrySend/discardSend 经 context 供 MessageSendStatus 直连,无 props 钻孔(冻结文件零增行)。
  const userRef = useRef(user)
  userRef.current = user
  const outboxDepsRef = useRef<{
    setMessagesAndCache: (updater: (prev: MessageItem[]) => MessageItem[], chatId: string) => void
    setThreadMessages: Dispatch<SetStateAction<MessageItem[]>>
    patchChat: (chatId: string, partial: Partial<ChatItem>) => void
    toast: (message: string, type?: ToastType) => void
    appendMessage: (message: MessageItem) => void
  } | null>(null)
  // 启动恢复(reload/崩溃后未送达的行重建 + 续投)+ window online kick;换用户重跑(db 句柄按 user 隔离)。
  useEffect(() => {
    if (!userId) return
    const wiring = createOutboxWiring({
      getImRepository,
      user: () => userRef.current ? { id: userRef.current.id, nickname: userRef.current.nickname, avatarUrl: userRef.current.avatarUrl ?? null } : null,
      chats: () => chatsRef.current,
      identity: (id) => imRepositoryRef.current?.snapshot().identity.find((row) => row.id === id)?.value,
      activeChatId: () => activeChatIdRef.current,
      activeThreadRootId: () => activeThreadRootIdRef.current,
      setMessagesAndCache: (updater, chatId) => outboxDepsRef.current?.setMessagesAndCache(updater, chatId),
      setThreadMessages: (updater) => outboxDepsRef.current?.setThreadMessages(updater),
      patchChat: (chatId, partial) => outboxDepsRef.current?.patchChat(chatId, partial),
      toast: (message, type) => outboxDepsRef.current?.toast(message, type),
      appendMessage: (message) => outboxDepsRef.current?.appendMessage(message),
    })
    outboxRef.current = wiring
    const stopWatching = wiring.restoreAndWatch()
    return () => {
      stopWatching()
      wiring.dispose()
      if (outboxRef.current === wiring) outboxRef.current = null
    }
  }, [userId, getImRepository])

  /** 当前选中被权威地撤销了。⚠️ 落地那个 await 里用户可能又选了别条 —— 那是**更新的意图**(#4314)。 */
  const onActiveRevoked = useCallback((chatId: string) => {
    messagesCacheRef.current.delete(chatId)
    if (activeChatIdRef.current !== chatId) return
    setActiveChatIdState(null)
    historyWindow.reset(null)
    setMemberReadSeqs({})
  }, [historyWindow, setActiveChatIdState, setMemberReadSeqs])

  // @@@chat-projection — 会话列表的每一发云端取数都经投影(spec I7 唯一属主):按键取数、按戳 join,
  // 一条通知的代价与账号里有多少会话无关。绑定的三件事在 chatProjectionBinding.ts。
  const chatProjection = useChatProjectionBinding({
    ledger: projectionRef.current, repositoryRef: imRepositoryRef, getRepository: getImRepository,
    chatsRef, activeChatIdRef, requestSeqRef: listRequestSeqRef, setChats, onActiveRevoked,
    notifications: { chatMessages: notificationSettings.chatMessages, sound: notificationSettings.sound },
  })

  const loadChats = useCallback(async (options: RefreshChatsOptions = {}) => {
    if (!user) return
    const isFirstLoad = chatsRef.current.length === 0
    setChatsLoad((state) => (isFirstLoad ? 'loading' : state === 'failed' ? 'idle' : state))
    const requestSeq = ++listRequestSeqRef.current
    try {
      // 冷启快照也走投影(spec I7:会话列表只有一条拉取路)—— 一次「哪些会话属于我」的读 + 同一套族读。
      // ❌ 没有「空了就等 500 ms 再读一遍」那一手:同一游标上重读是重放,投影按 I3 一发都不打
      // (它会原样交回同一份行)。刚建号/刚建会话时成员行**晚一点**提交,命名它的是 journal 的
      // 那条 operation(服务端义务 O1),路径是 wake → advance,不是一次定时轮询。
      const data = await chatProjection.hydrate(user.id)
      if (data.length > 0 || chatsRef.current.length === 0 || options.acceptEmpty === true) {
        // 选中一条会话是**用户的意图**,不是列表刷新的投影 —— 什么时候才算「它没了」由账本判(#4314)。
        await chatProjection.publish(data, chatProjection.identities(user.id), {
          requestSeq, notify: !isFirstLoad, preserveMissingActive: options.preserveMissingActive,
        })
      }
    } catch (err) {
      if (!isLifecycleCancellation(err)) { console.error('[ChatStore] loadChats error', err); setChatsLoad('failed') } // #2187 取消≠失败
      if (options.throwOnError) throw err
    } finally {
      setChatsLoad((state) => (state === 'loading' ? 'idle' : state))
    }
  }, [chatProjection, user])

  const patchChat: PatchChat = useCallback((chatId, partial, expectedReadStateVersion) => {
    setChats((prev) => patchChatRows(prev, chatId, partial, expectedReadStateVersion))
  }, [])

  const upsertChat = useCallback((chat: ChatItem) => {
    // 对端身份本地还没有的乐观行(刚 open_dm 出来的 agent 私聊)由 adoptOptimisticChatRow 收下:
    // 补齐身份后才登记,并记进投影账本 —— 此后每次列表落地都补回去 (#4314)。
    if (adoptOptimisticChatRow({
      chat, repository: imRepositoryRef.current, ledger: projectionRef.current,
      refresh: () => { void loadChats() },
      applyRow: (row) => setChats((prev) => (prev.some((i) => i.id === row.id) ? prev : upsertChatRow(prev, row))),
    })) return
    setChats((prev) => upsertChatRow(prev, chat))
  }, [loadChats])

  const mergeMessagesSnapshot = useCallback((chatId: string, msgs: MessageItem[]): MessageItem[] => {
    const base = messagesCacheRef.current.get(chatId) ?? (
      activeChatIdRef.current === chatId ? messagesRef.current : []
    )
    return mergeMessagesById(base, msgs, chatId)
  }, [messagesRef])

  const { epochOf: getMessageSnapshotEpoch, bump: bumpMessageSnapshotEpoch } = useMessageSnapshotEpochs()

  const invalidateMessageSnapshots = useCallback((chatId: string): number => {
    const next = bumpMessageSnapshotEpoch(chatId)
    if (chatId === activeChatIdRef.current) historyWindow.invalidate()
    return next
  }, [bumpMessageSnapshotEpoch, historyWindow])

  const applyFreshMessageSnapshot = useCallback((chatId: string, msgs: MessageItem[], epoch: number): MessageItem[] | null => {
    if (epoch !== getMessageSnapshotEpoch(chatId)) return null
    // @@@chat-isolation - a fresh load establishes the window; trim to MESSAGE_WINDOW so the
    // cache + rendered list hold only the recent window (isolation contract). initialLoad returns ≤60.
    const nextMessages = activeChatIdRef.current === chatId
      ? (historyWindow.update((previous) => mergeMessagesById(previous, msgs, chatId)), historyWindow.getSnapshot().messages)
      : trimToMessageWindow(mergeMessagesSnapshot(chatId, msgs))
    messagesCacheRef.current.set(chatId, nextMessages)
    // @@@msg-cache (#621/P2/#947) - write-through L2: this is the canonical window-commit point for
    // initialLoad / loadNewer / toggleReaction / refreshMessages, so persisting here keeps the durable
    // cache in lockstep with L1 (same contract as messagesCacheRef.set above).
    persistWindowToLocalSync(chatId, nextMessages)
    return nextMessages
  }, [getMessageSnapshotEpoch, historyWindow, mergeMessagesSnapshot, persistWindowToLocalSync])

  /** 返回 false = 未落窗(未登录或快照 epoch 已变被拒收)。 */
  const applyMessagesSnapshot = useCallback((chatId: string, msgs: MessageItem[], readSeqs: Record<string, number> | null, epoch: number): boolean => {
    if (!user) return false
    const nextMessages = applyFreshMessageSnapshot(chatId, msgs, epoch)
    if (!nextMessages) return false
    const stillActive = activeChatIdRef.current === chatId
    // #1529 单调 reconcile(唯一实现在卫星,与 heal 无增量分支共用)。
    if (stillActive && readSeqs) reconcileMemberReadSeqs(chatId, readSeqs, { memberReadSeqsChatRef, setMemberReadSeqs }) // null = 载荷无水位,别动表(#5649)
    const lastPersistedSeq = Math.max(0, ...nextMessages.map((msg) => msg.seq).filter((seq) => seq >= 0))
    if (stillActive && chatOnScreen() === chatId && historyWindow.isFollowingTail() && lastPersistedSeq > 0 && !unreadNavigationRef.current?.ownsChat(chatId)) advanceReadWatermark(chatsRef.current, chatId, lastPersistedSeq, patchChat)
    return true
  }, [applyFreshMessageSnapshot, historyWindow, memberReadSeqsChatRef, patchChat, setMemberReadSeqs, user])

  const refreshMessages = useCallback(async (chatId = activeChatIdRef.current ?? undefined) => {
    if (!chatId || !user) return
    const epoch = getMessageSnapshotEpoch(chatId)
    revalidateInFlightRef.current.add(chatId)
    try {
      const [msgs, readSeqs] = await trackMessageRead(chatId, Promise.all([
        chatService.getMessages(chatId, user.id, 'initialLoad', INITIAL_PAGE),
        chatService.getOtherMembersReadSeqs(chatId, user.id),
      ]))
      applyMessagesSnapshot(chatId, msgs, readSeqs, epoch)
    } finally {
      revalidateInFlightRef.current.delete(chatId)
    }
  }, [applyMessagesSnapshot, getMessageSnapshotEpoch, trackMessageRead, user])

  // ── #621 incremental spine ────────────────────────────────────────────────
  const windowRowsOf = useCallback((chatId: string) => messagesCacheRef.current.get(chatId), [])
  // maxSeqOf: the spine cursor ("new messages?" = expectedTail > maxSeq), cache-derived so it can't drift.
  const maxSeqOf = useCallback((chatId: string): number => maxMainlineSeq(windowRowsOf(chatId)), [windowRowsOf])
  // expectedTailSeq: the latest seq that should exist = chat.next_message_seq - 1 (seq is 1-BASED per
  // 004_chat_extensions — DEFAULT 1, RETURNING next-1 — continuous & hole-free; 0 = "no messages yet").
  const expectedTailSeq = useCallback((chatId: string): number => {
    const chat = chatsRef.current.find((c) => c.id === chatId)
    return Math.max(0, (chat?.next_message_seq ?? 0) - 1)
  }, [])
  // revalidateWindowOverlays: refresh the cached window's MUTABLE state for its message ids WITHOUT
  // re-fetching bodies of new messages. Bounded to ≤ window size — ONE call per open/reconnect.
  // @@@msg-cache (#621/P2/#947) - extended beyond reactions/delivery to also cover delete / edit / retract
  // (none of which gugu has realtime for), so the persistent L2 cache stays correct on a cached reopen:
  // reaction/delivery overlays + edit/retract body fields patch surviving rows in place, and ids that no
  // longer exist for this user (deleted globally or for-me) are dropped — else a message deleted while the
  // app was closed would resurrect from L2 on cold start (the second staleness vector L2 introduces).
  // Optimistic rows (seq < 0, client UUIDs not yet in the view) are NEVER queried or dropped. Fail-soft: a
  // glitch must not block the open, and an errored chunk reports its ids as present so it never deletes rows.
  const revalidateWindowOverlays = useCallback(
    async (chatId: string, throwOnError = false) => {
      if (!user) return
      const cached = messagesCacheRef.current.get(chatId)
      if (!cached || cached.length === 0) return
      const ids = cached.filter((m) => m.seq >= 0).map((m) => m.id)
      if (ids.length === 0) return
      try {
        const revalidation = await chatService.revalidateWindow(ids, user.id)
        const queriedIds = new Set(ids)
        // Pure transform applied to a window: drop ids gone from presentIds, patch overlays/mutations, keep
        // optimistic rows. Used for BOTH the state update and the L2 write-through so the persisted window is
        // computed deterministically — NOT read back from the cache (the active-chat cache.set runs inside the
        // setMessages updater, so reading it back synchronously here would persist the STALE pre-drop window).
        const applyRevalidation = (list: MessageItem[]): MessageItem[] =>
          applyMessageWindowRevalidation(list, queriedIds, revalidation)
        setMessagesAndCache((prev) => applyRevalidation(prev), chatId)
        // @@@msg-cache (#621/P2/#947) - persist the revalidated window so the durable cache reflects the
        // patched/dropped rows (this path doesn't go through applyFreshMessageSnapshot's write-through).
        // Compute from the window we revalidated (`cached`) rather than reading the not-yet-applied cache back.
        persistWindowToLocalSync(chatId, applyRevalidation(messagesCacheRef.current.get(chatId) ?? cached))
      } catch (err) {
        if (!isLifecycleCancellation(err)) console.error('[ChatStore] revalidateWindowOverlays failed', err) // #2187 取消≠失败
        if (throwOnError) throw err
      }
    },
    [persistWindowToLocalSync, setMessagesAndCache, user],
  )
  // @@@1888 — resubscribe = 重验证:增量 delta(seq > 主线缓存 max)直接问服务端,**结果即真值**——
  // 空 = 无 gap;短页 = 补齐;整页 = 断档可能超一页 → 交给 refreshMessages 权威重载(#621 既有
  // degrade 原语,判定在结果侧,不做预测)。此前用 chatsRef 的 next_message_seq 做客户端 gap 预测,
  // 重连时恰恰是它最 stale 的时刻(且它计入话题 seq、与主线 cursor 单位错配 → 假 gap 恒真),按预测
  // 跳过的 heal 会静默漏消息——预测层删除,勿再引入。并发语义:重连风暴下同 chat 的多次 heal
  // 幂等收敛(同 cursor 的 delta + epoch 门 + 单调 merge + chokepoint 水位),重复代价 = 有界查询,
  // 且已被订阅层重连退避(RECONNECT_DELAYS)限流,故不设去重机制。
  const healMessageGap = useCallback(
    async (chatId: string, throwOnError = false) => {
      if (!user) return
      const maxSeq = maxSeqOf(chatId)
      const epoch = getMessageSnapshotEpoch(chatId)
      revalidateInFlightRef.current.add(chatId)
      try {
        // @@@5856 原来这里还并行拉一次 chat.thread_summaries。群 thread 面板退役后没有任何 surface
        // 读它 —— 每开一次会话白跑一次往返。话题是**另一条 chat**,它的摘要不在这条线的聚合里。
        const [threadSnap, msgs, readSeqs] = await Promise.all([
          fetchOpenThreadSnapshot({ chatId, userId: user.id, activeThreadRootId: () => activeThreadRootIdRef.current }),
          chatService.getMessages(chatId, user.id, 'loadNewer', NEWER_PAGE, undefined, maxSeq),
          chatService.getOtherMembersReadSeqs(chatId, user.id),
        ])
        // R6 被新快照取代的补洞结果不许静默丢:会话仍在屏上就抛错,让修订派发重补。
        if (msgs.length > 0) commitHealedMessages({ chatId, apply: () => applyMessagesSnapshot(chatId, msgs, readSeqs, epoch), stillActive: () => activeChatIdRef.current === chatId })
        else if (activeChatIdRef.current === chatId) reconcileMemberReadSeqs(chatId, readSeqs, { memberReadSeqsChatRef, setMemberReadSeqs })
        if (msgs.length >= NEWER_PAGE) await refreshMessages(chatId)
        if (threadSnap) {
          applyThreadSnapshot({ chatId, ...threadSnap, chats: chatsRef.current, setThreadMessages, patchChat,
            activeChatId: () => activeChatIdRef.current, activeThreadRootId: () => activeThreadRootIdRef.current })
          if (threadSnap.rootId && !unreadNavigationRef.current?.ownsThread(chatId, threadSnap.rootId)) markLatestThreadRead(chatId, threadSnap.rootId, threadSnap.msgs)
        }
        await revalidateWindowOverlays(chatId, throwOnError)
        noteFreshMessageRead(chatId) // #7199 补洞成了:窗口到了最新,「没能读到最新的」不再成立
      } catch (err) {
        if (!isLifecycleCancellation(err)) console.error('[ChatStore] healMessageGap failed', err) // #2187 取消≠失败
        if (throwOnError) throw err
      } finally {
        revalidateInFlightRef.current.delete(chatId)
        healCycleCountRef.current += 1
      }
    },
    [applyMessagesSnapshot, getMessageSnapshotEpoch, maxSeqOf, memberReadSeqsChatRef, noteFreshMessageRead, patchChat, refreshMessages, revalidateWindowOverlays, setMemberReadSeqs, user],
  )
  const loadHistoryPage = useCallback(async (direction: 'older' | 'newer' | 'latest') => {
    if (!user) return
    try {
      const changed = await historyWindow.load(direction, (chatId, way, cursor, limit) =>
        way === 'newer' ? chatService.getMessages(chatId, user.id, 'loadNewer', limit, undefined, cursor)
          : chatService.getMessages(chatId, user.id, way === 'older' ? 'loadOlder' : 'initialLoad', limit, way === 'older' ? cursor : undefined))
      const window = historyWindow.getSnapshot()
      if (changed && window.chatId) { cacheHistoryWindow(); persistWindowToLocalSync(window.chatId, window.messages) }
      if (direction !== 'older' && window.chatId) noteFreshMessageRead(window.chatId) // #7199 往新翻 / 回到最新成了:读得到最新的了
    } catch (err) {
      if (!isLifecycleCancellation(err)) console.error('[ChatStore] history page failed', err)
      throw err
    }
  }, [user, cacheHistoryWindow, historyWindow, noteFreshMessageRead, persistWindowToLocalSync])
  const loadOlderMessages = useCallback(() => loadHistoryPage('older'), [loadHistoryPage])
  const loadNewerMessages = useCallback(() => loadHistoryPage('newer'), [loadHistoryPage])
  const loadMessageAnchor = useCallback(async (messageId: string) => {
    if (!user) return
    const changed = await historyWindow.restoreAnchor(async (chatId) => {
      const anchor = await chatService.getMessageById(messageId, user.id)
      if (!anchor || anchor.chat_id !== chatId || anchor.thread_root_id) throw new Error('Saved conversation message is no longer available')
      const [older, newer] = await Promise.all([
        chatService.getMessages(chatId, user.id, 'loadOlder', 20, anchor.seq + 1),
        chatService.getMessages(chatId, user.id, 'loadNewer', 20, undefined, anchor.seq),
      ])
      const messages = mergeMessagesById(older, newer, chatId)
      if (!messages.some((row) => row.id === messageId)) throw new Error('Saved conversation message is no longer visible')
      return { messages, hasNewer: newer.length === 20 }
    })
    if (changed) cacheHistoryWindow()
  }, [user, cacheHistoryWindow, historyWindow])
  const returnToLatestMessages = useCallback(() => {
    const chatId = activeChatIdRef.current
    if (chatId) invalidateMessageSnapshots(chatId)
    return loadHistoryPage('latest')
  }, [invalidateMessageSnapshots, loadHistoryPage])
  const setFollowingTail = useCallback((following: boolean) => {
    historyWindow.setFollowingTail(following)
    cacheHistoryWindow()
  }, [cacheHistoryWindow, historyWindow])
  const markMessageVisible = useCallback((message: MessageItem) => {
    const chatId = activeChatIdRef.current
    if (!user || message.chat_id !== chatId || message.seq < 1 || message.is_mine || message.thread_root_id || !chatId) return
    if (unreadNavigationRef.current?.ownsChat(chatId) || !messagesRef.current.some((row) => row.id === message.id)) return
    const chat = chatsRef.current.find((row) => row.id === chatId)
    if (!chat || message.seq <= chat.last_read_seq) return
    // Reading one page must not erase the server's unread locator for later pages.
    advanceReadWatermark(chatsRef.current, chatId, message.seq, patchChat, { unread_count: chat.unread_count, unread_locator: chat.unread_locator })
  }, [messagesRef, patchChat, user])

  useEffect(() => {
    if (!user) {
      setChats([]); setChatsLoad('idle') // 换号 / 登出:上一个号的读失败 ❌ 带到下一个号的「群」那一格
      return
    }
    let cancelled = false
    void getImRepository()
      .then(async (repository) => {
        if (cancelled) return
        const cached = readCompleteCachedChats(repository)
        if (cached.length > 0) {
          chatsRef.current = cached
          projectionRef.current.seedFromCache(cached) // durable snapshot = 上一次会话的服务端投影 (#4314)
          setChats(cached)
        }
        await loadChats()
      })
      .catch((err) => console.error('[ChatStore] open IM repository failed', err))
    return () => { cancelled = true }
  }, [getImRepository, loadChats, user])

  useEffect(() => {
    if (!userId || !imRepositoryRef.current) return
    void replaceChatRows(imRepositoryRef.current, chats)
      .catch((err) => console.error('[ChatStore] persist repository chats failed', err))
  }, [chats, userId])

  // ── Subscribe to durable account revisions ─────────────────────────────────
  useEffect(() => {
    if (!user) return
    const unsubscribes = [
      // @@@chat-projection — 投影认领它那组 event 并自己合批:一次 wake = 一次推进。从前这里每类
      // event 各自 `loadChats()`(整账号 8 波重拉),一条新消息就能打出 40 环串行(#5394)。
      chatProjection.attach(user.id, subscribeAccountRevision),
      // 在线状态的属主是 agentPresenceStore,不是会话列表:**不同状态的两个属主**,不是一份状态两条路。
      subscribeAccountRevision('presence_changed', async (operations) => { await refreshObservedAgentPresenceFromRevision(operations.map((operation) => operation.payload)) }),
      // These surfaces own no durable list while closed: opening them always performs an authoritative
      // fetch. Keep a mounted owner so an operation for a closed surface cannot head-of-line block the
      // account inbox; when the surface is open its scoped listener runs in the same dispatch.
      subscribeAccountRevision('group_collab_changed', () => undefined),
      subscribeAccountRevision('workspace_changed', () => undefined),
    ]
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe()
    }
  }, [user, chatProjection, subscribeAccountRevision])

  // ── Load messages when active chat changes (SWR) ───────────────────────────
  useEffect(() => {
    if (!activeChatId || !user) {
      setMessages([])
      setMemberReadSeqs({})
      return
    }
    let cancelled = false
    unreadNavigationRef.current?.beginChatOpen(activeChatId)
    const cached = messagesCacheRef.current.get(activeChatId)
    const hasSettledL1 = !!cached?.some((message) => message.seq >= 0)
    const epoch = getMessageSnapshotEpoch(activeChatId)
    const openSeq = ++chatOpenSeqRef.current
    setLoadingMessages(!cached?.length)
    // A fresh chat opens pinned to the tail; a cached reopen keeps its older-history boundary.
    if (!hasSettledL1) setHasMoreOlder(false)
    revalidateInFlightRef.current.add(activeChatId)
    const current = () =>
      !cancelled && openSeq === chatOpenSeqRef.current && activeChatIdRef.current === activeChatId
    const done = (error?: Error) => { revalidateInFlightRef.current.delete(activeChatId); if (current()) unreadNavigationRef.current?.finishChatOpen(activeChatId, error) }
    // Commit a fetched snapshot, clear flags, optionally run the bounded overlay/mutation revalidation.
    const finalize = async (
      msgs: MessageItem[],
      readSeqs: Record<string, number>,
      opts: { hasMoreOlder?: boolean; revalidate: boolean; replaceTail?: boolean },
    ) => {
      if (!current()) { done(); return }
      if (opts.replaceTail && epoch === getMessageSnapshotEpoch(activeChatId)) {
        historyWindow.establishTail(msgs)
        cacheHistoryWindow()
      }
      applyMessagesSnapshot(activeChatId, msgs, readSeqs, epoch)
      if (opts.hasMoreOlder !== undefined) setHasMoreOlder(opts.hasMoreOlder)
      setLoadingMessages(false)
      done()
      if (opts.revalidate) await revalidateWindowOverlays(activeChatId)
    }

    const run = async () => {
      // 1. Resolve the cache to decide from. L1 = same-session reopen (already painted in setActiveChatId);
      //    L2 = cold restart — read IndexedDB and paint it now for an instant first frame.
      let painted = hasSettledL1
      if (!hasSettledL1) {
        // Only reached when the repository was not open yet at selection time (cold start); otherwise
        // setActiveChatId already painted the disk window synchronously.
        const repository = await getImRepository()
        if (!current()) { done(); return }
        const disk = epoch === getMessageSnapshotEpoch(activeChatId) ? seedCacheFromDisk(messagesCacheRef.current, repository, activeChatId) : null
        if (disk) {
          setMessages(disk.rows)
          setHasMoreOlder(disk.hasMoreOlder)
          setLoadingMessages(false)
          painted = true
        }
      }

      // 2. Shared decision: how to reconcile against the server WITHOUT leaving a hole.
      const plan = decideColdStartFetch({
        hasCache: painted,
        maxSeq: painted ? maxSeqOf(activeChatId) : 0,
        expectedTailSeq: expectedTailSeq(activeChatId),
        hasPositiveUnread: (chatsRef.current.find((c) => c.id === activeChatId)?.unread_count ?? 0) > 0, // @@@2160
      })

      if (plan.kind === 'paintRevalidateOnly') {
        // Gap-free: serve the body from cache, refresh only readSeqs + bounded overlays/mutations.
        const readSeqs = await chatService.getOtherMembersReadSeqs(activeChatId, user.id)
        await finalize(messagesCacheRef.current.get(activeChatId) ?? [], readSeqs, { revalidate: true })
        return
      }
      if (plan.kind === 'paintLoadNewerDelta') {
        // Fetch ONLY the delta (seq > cursor). @@@1926 result-side degrade: a short/empty page means the
        // cache already covered the mainline tail (the "gap" was thread-reply inflation) → merge & keep.
        // A FULL page is server evidence the real mainline gap may exceed one page → the delta may leave a
        // hole → fall through to the initialLoad degrade below (no longer predicted from the seq math).
        const [msgs, readSeqs] = await Promise.all([
          chatService.getMessages(activeChatId, user.id, 'loadNewer', NEWER_PAGE, undefined, plan.sinceSeq),
          chatService.getOtherMembersReadSeqs(activeChatId, user.id),
        ])
        if (!deltaResultRequiresDegrade(msgs.length, NEWER_PAGE)) {
          await finalize(msgs, readSeqs, { revalidate: true })
          return
        }
      }
      // initialLoad — no usable cache (plain cold), OR a full-page delta above we DEGRADE rather than risk a
      // hole. In the degrade-with-cache case the painted window is too far behind: discard it so the
      // snapshot establishes a fresh, CONTIGUOUS tail window (else merge+trim would leave a hole). Older
      // then definitely exists → hasMoreOlder = true. The plain cold case sets it from the page fill.
      const degradeWithCache = painted
      const [msgs, readSeqs] = await Promise.all([
        chatService.getMessages(activeChatId, user.id, 'initialLoad', INITIAL_PAGE),
        chatService.getOtherMembersReadSeqs(activeChatId, user.id),
      ])
      await finalize(msgs, readSeqs, {
        hasMoreOlder: degradeWithCache ? true : msgs.length >= INITIAL_PAGE,
        revalidate: false,
        replaceTail: degradeWithCache,
      })
    }

    trackMessageRead(activeChatId, run()).catch((err) => {
      if (!isLifecycleCancellation(err)) console.error('[ChatStore] load messages error', err) // #2187 取消≠失败
      done(err instanceof Error ? err : new Error(String(err)))
      if (!cancelled) setLoadingMessages(false)
    })
    return () => { cancelled = true; unreadNavigationRef.current?.cancelChatOpen(activeChatId, new Error(`Chat ${activeChatId} open was superseded`)) }
  }, [activeChatId, user, applyMessagesSnapshot, cacheHistoryWindow, expectedTailSeq, getImRepository, getMessageSnapshotEpoch, maxSeqOf, revalidateWindowOverlays, messagesRef, setMessages, setHasMoreOlder, setMemberReadSeqs, trackMessageRead, historyWindow])
  const activeChat = chats.find((c) => c.id === activeChatId) ?? null
  // ── Durable revision consumers for active-chat state ───────────────────────
  // #6470 主区的 activeChat 是一条「线」:线级修订与话题分栏走同一个 subscribeChatLineRevisions,这里只交端口。
  useEffect(() => {
    if (!user) return
    const unsubscribeLine = subscribeChatLineRevisions(subscribeAccountRevision, { userId: user.id, chatId: () => activeChatIdRef.current,
      maxSeqOf, getMessageSnapshotEpoch, applyMessagesSnapshot, healMessageGap, revalidateWindowOverlays,
      setMessagesAndCache, persistWindowToLocalSync, setThreadMessages, memberReadSeqsChatRef, setMemberReadSeqs, readMemberReadSeqs })
    const unsubscribeDecisions = subscribeAccountRevision('gugu_decision_event', () => loadChats({ acceptEmpty: true, throwOnError: true }))
    return () => { unsubscribeLine(); unsubscribeDecisions() }
  }, [user, applyMessagesSnapshot, getMessageSnapshotEpoch, healMessageGap, loadChats, maxSeqOf, memberReadSeqsChatRef, persistWindowToLocalSync, readMemberReadSeqs, revalidateWindowOverlays, setMemberReadSeqs, setMessagesAndCache, subscribeAccountRevision])

  // ── Actions ────────────────────────────────────────────────────────────────
  const setActiveChatId = useCallback((id: string | null) => {
    const previousChatId = activeChatIdRef.current
    // 重选当前会话(再点一次列表行、点它底下的话题)什么都不变:从前这里照样 reset 窗口 → viewVersion+1 → 整个列表重挂 = 白闪。
    if (previousChatId === id) return
    if (previousChatId) {
      cancelChatOpenRef.current(previousChatId, new Error(`Chat ${previousChatId} open was superseded by ${id ?? 'no chat'}`))
      messagesCacheRef.current.set(previousChatId, trimToMessageWindow(messagesRef.current))
      invalidateMessageSnapshots(previousChatId)
    }
    historyWindow.reset(id)
    activeChatIdRef.current = id
    setActiveChatIdState(id)
    activeThreadRootIdRef.current = null; setActiveThreadRootId(null); setThreadMessages([])
    if (id && imRepositoryRef.current) seedCacheFromDisk(messagesCacheRef.current, imRepositoryRef.current, id) // 同一帧画出盘上的窗,不先闪骨架
    if (id && messagesCacheRef.current.has(id)) {
      const cached = messagesCacheRef.current.get(id)!
      // @@@chat-bleed (critical): drop any foreign-chat entries a cross-chat prev-bleed wrote into this
      // cache. If any are found, the cache is unreliable → invalidate it (delete) so the SWR load effect
      // cold-opens a fresh fetch instead of painting/ perpetuating the poisoned content. Targeted by
      // chat_id (not a blind full-cache wipe).
      const clean = cached.filter((m) => m.chat_id === id)
      if (clean.length !== cached.length) {
        messagesCacheRef.current.delete(id)
        setMessages([])
      } else {
        // @@@chat-isolation (#504/俊傑) - paint only the window, not the full unbounded cache.
        historyWindow.reset(id, clean)
        setLoadingMessages(false)
      }
    } else {
      setMessages([])
    }
  }, [historyWindow, invalidateMessageSnapshots, messagesRef, setActiveChatIdState, setMessages])

  const unreadNavigation = useChatUnreadStreamNavigation({ user, chatsRef, activeChatIdRef, activeThreadRootIdRef, invalidateMessageSnapshots, getMessageSnapshotEpoch, setActiveChatId, setActiveThreadRootId, setLoadingThread, setThreadMessages, setFollowingTail, setMessagesAndCache: (updater, chatId, commit) => { historyWindow.replace(updater, commit.reachedTail); cacheHistoryWindow() }, loadChats, cancelChatOpenRef })
  unreadNavigationRef.current = unreadNavigation
  // @@@threads — 打开/关闭话题视图。传 rootId 打开并拉取该话题的 root+回复；传 null 回主时间线。
  const openThread = useCallback((rootId: string | null) => {
    activeThreadRootIdRef.current = rootId
    setActiveThreadRootId(rootId)
    if (!rootId || !activeChatIdRef.current || !user) {
      setThreadMessages([])
      setLoadingThread(false) // 关话题时清掉(防上一话题 fetch 在途时关闭→loading 卡 true)
      return
    }
    const chatId = activeChatIdRef.current
    // @@@threads (#1196 Q2) — 开 thread 即标 root（ruling A）：乐观把主线该消息标 is_thread_root
    // → 立刻显 tanchor，不等首条回复；再持久化(mark_thread_root RPC，幂等 best-effort)。已是 root 则无副作用。
    setMessagesAndCache(
      (prev) => prev.map((m) => (m.id === rootId && !m.is_thread_root ? { ...m, is_thread_root: true } : m)),
      chatId,
    )
    void chatService.markThreadRoot(chatId, rootId).catch((err) => console.error('[ChatStore] markThreadRoot error', err))
    setLoadingThread(true)
    setThreadMessages([])
    void (async () => {
      try {
        const msgs = await chatService.getThreadMessages(chatId, rootId, user.id)
        // 落地+竞态守卫+@@@1886 开话题即推水位——与 heal 的话题落地共用卫星实现(乐观行保留)。
        applyThreadSnapshot({ chatId, rootId, msgs, chats: chatsRef.current, setThreadMessages, patchChat,
          activeChatId: () => activeChatIdRef.current, activeThreadRootId: () => activeThreadRootIdRef.current })
        if (!unreadNavigationRef.current?.ownsThread(chatId, rootId)) markLatestThreadRead(chatId, rootId, msgs)
        outboxRef.current?.injectThreadOutboxRows(chatId, rootId) // #1762 洞③ 恢复的未决话题行注入
      } catch (err) {
        console.error('[ChatStore] openThread error', err)
      } finally {
        if (activeThreadRootIdRef.current === rootId) setLoadingThread(false)
      }
    })()
  }, [user, setMessagesAndCache, patchChat])
  const sendMessageToChat = useCallback(
    async (
      targetChatId: string,
      content: string,
      opts: SendMessageOptions = {}
    ) => {
      if (!targetChatId || !user || !content.trim()) return
      const targetChat = chatsRef.current.find((chat) => chat.id === targetChatId) ?? null
      const explicitToUserIds = opts.toUserIds?.length ? opts.toUserIds : null
      const isDirectChat = targetChat?.kind === 'dm' || targetChat?.kind === 'ai'
      const toUserIds =
        explicitToUserIds ??
        (isDirectChat && targetChat.peer_user_id ? [targetChat.peer_user_id] : null)
      // #1554 DM/ai 首条竞态:peer_user_id 未就绪时 toUserIds 为 null,直接发出 → enqueue 触发器 DM 分支
      // 不投递 → agent 首条不运行。C2:对端解析挪到投递阶段(outbox prepare),乐观行先上屏;
      // 解析不到在投递时 fail loud(气泡「未送达」可重试),不发 null-target 哑消息。
      const resolveDmPeer = !toUserIds && isDirectChat

      // Single client-generated UUID flows through optimistic tempMsg.id AND the
      // DB row's primary key — so realtime echo carries an identical id, and
      // mergeById can reuse the prev reference (no key churn → no remount → no flicker).
      const id = opts.clientMessageId ?? crypto.randomUUID()
      const threadRootId = opts.threadRootId ?? null
      const tempMsg: MessageItem = {
        id,
        chat_id: targetChatId,
        sender_user_id: user.id,
        to_user_ids: toUserIds,
        // @@@whisper (#820) - optimistic whisper styling without waiting for the server echo
        is_whisper: !!opts.isWhisper,
        seq: -1,
        content: content.trim(),
        content_type: 'text',
        ...optimisticReplyFields(messagesRef.current, opts.replyToMessageId ?? null), // @@@2015 乐观回复带全引用预览,回声前空名会触发 #1624
        thread_root_id: threadRootId,
        is_thread_root: !!opts.isThreadRoot, // @@@threads (#1531) 乐观显 tanchor，不等 openThread 异步补
        retracted_at: null,
        created_at: new Date().toISOString(),
        reactions: [],
        is_mine: true,
        delivered: false,
        delivery_status: null,
        local_send_state: 'sending',
      }

      // @@@threads (#957) — 话题内消息带 thread_root_id，getMessages 会把它从主时间线过滤掉，
      // 故乐观更新落 threadMessages（而非主线，避免闪一下又消失）。主线消息走原乐观追加。
      if (threadRootId) {
        setThreadMessages((prev) => [...prev, tempMsg])
      } else {
        // C3 发送把窗口钉回底部:含尾的窗口立即恢复跟尾(确认行按尾巴接上,不被当成窗口外丢掉);
        // 离尾的历史段先拉最新页(页里保留这条乐观行及其确认行)。已在拉就不重开。
        if (activeChatIdRef.current === targetChatId && !historyWindow.followForSend()
          && historyWindow.getSnapshot().loading !== 'latest') {
          void returnToLatestMessages().catch((error) => revisionLog.error({ error }, 'pin to latest on send failed'))
        }
        setMessagesAndCache((prev) => [...prev, tempMsg], targetChatId)
      }

      // @@@send-outbox (#1762 洞③/#1941) — 入队即返回(resolve ≠ 已送达):投递/超时/退避重试/失败
      // 可见性全归 outbox(唯一 chokepoint);送达连带动作(权威 row/水位/预览/agent 运行态点亮)在
      // wiring.onSent,实时发送与 reload 恢复投递同一条路径。
      try {
        await outboxRef.current!.enqueue({
          id, chatId: targetChatId, senderUserId: user.id, content: content.trim(),
          toUserIds, replyToMessageId: opts.replyToMessageId ?? null,
          threadRootId, isThreadRoot: !!opts.isThreadRoot, isWhisper: !!opts.isWhisper,
          resolveDmPeer, beforeDeliver: opts.beforeDeliver,
        })
      } catch (error) {
        if (threadRootId) {
          setThreadMessages((prev) => prev.filter((message) => message.id !== id))
        } else {
          setMessagesAndCache((prev) => prev.filter((message) => message.id !== id), targetChatId)
        }
        throw error
      }
      // 侧栏预览不在入队时乐观写:丢弃无法回滚会让列表永远展示已丢弃文本(#1762 评审[10]);
      // 预览唯一写点 = wiring.onSent(送达后)。
      // @@@threads (#1531) — 新建话题的 root 是结构性发送:enqueue 触发器在 INSERT 时按 is_thread_root
      // 路由后续回复,root 未落库就开话题composer = 回复投向不存在的锚(#1762 评审[6][8])。等真送达,
      // 失败即抛(与旧行为等价:InputArea 回滚 + toast)。普通消息保持入队即返回。
      if (opts.isThreadRoot) await outboxRef.current!.outbox.delivered(id)
      // @@@threads (#957) — 返回消息 id,供「新建话题」首条发完后 openThread(它) 进入话题。
      return id
    },
    [user, setMessagesAndCache, messagesRef, historyWindow, returnToLatestMessages],
  )

  const sendMessage = useCallback(
    async (content: string, opts: Parameters<typeof sendMessageToChat>[2] = {}) => {
      if (!activeChatIdRef.current) return undefined
      return sendMessageToChat(activeChatIdRef.current, content, opts)
    },
    [sendMessageToChat],
  )

  // @@@send-outbox — failed 态的重试/丢弃(MessageSendStatus 经 context 直连)。
  const retrySend = useCallback((messageId: string) => { outboxRef.current?.retrySend(messageId) }, [])
  const discardSend = useCallback((messageId: string) => { outboxRef.current?.discardSend(messageId) }, [])

  const toggleReaction = useCallback(
    async (messageId: string, emoji: string) => {
      const chatId = activeChatIdRef.current
      if (!user || !chatId) return
      const epoch = getMessageSnapshotEpoch(chatId)
      await chatService.toggleReaction(messageId, user.id, emoji)
      const msgs = await chatService.getMessages(chatId, user.id, 'toggleReaction')
      applyFreshMessageSnapshot(chatId, msgs, epoch)
    },
    [applyFreshMessageSnapshot, getMessageSnapshotEpoch, user],
  )

  const createGroupChat = useGroupCreation({ userId, loadChats, setChats, toast })

  const clearMessages = useCallback(async () => {
    const chatId = activeChatIdRef.current
    if (!chatId) return
    // @@@mutation-window - first invalidate older snapshots, then invalidate snapshots started while the RPC was in flight.
    invalidateMessageSnapshots(chatId)
    await chatService.clearMessagesForMe(chatId)
    invalidateMessageSnapshots(chatId)
    messagesCacheRef.current.set(chatId, [])
    if (activeChatIdRef.current === chatId) {
      historyWindow.reset(chatId)
    }
    // @@@msg-cache (#947) - clear the durable L2 window too, else a cold-start reopen would resurrect the
    // cleared messages from IndexedDB (write-through here keeps L2 in lockstep with the now-empty L1).
    persistWindowToLocalSync(chatId, [])
  }, [historyWindow, invalidateMessageSnapshots, persistWindowToLocalSync])

  const removeMessage = useCallback((messageId: string) => {
    if (activeChatIdRef.current) {
      setMessagesAndCache((prev) => prev.filter((m) => m.id !== messageId), activeChatIdRef.current)
    } else {
      setMessages((prev) => prev.filter((m) => m.id !== messageId))
    }
  }, [setMessages, setMessagesAndCache])

  const deleteMessage = useCallback(async (messageId: string) => {
    const activeChatIdAtStart = activeChatIdRef.current
    // @@@mutation-window - first invalidate older snapshots, then invalidate snapshots started while the RPC was in flight.
    if (activeChatIdAtStart) invalidateMessageSnapshots(activeChatIdAtStart)
    const { chatId } = await chatService.deleteMessage(messageId)
    invalidateMessageSnapshots(chatId)
    // Compute the post-delete window explicitly (React state updates aren't synchronous) so the L2
    // write-through below persists exactly what L1 becomes — no resurrection of the deleted row on reopen.
    const base = messagesCacheRef.current.get(chatId)
      ?? (activeChatIdRef.current === chatId ? messagesRef.current : [])
    const filtered = base.filter((m) => m.id !== messageId)
    if (activeChatIdRef.current === chatId) {
      setMessagesAndCache((prev) => prev.filter((m) => m.id !== messageId), chatId)
    } else {
      const cached = messagesCacheRef.current.get(chatId)
      if (cached) {
        messagesCacheRef.current.set(chatId, cached.filter((m) => m.id !== messageId))
      }
    }
    // @@@msg-cache (#947) - keep the durable L2 window in lockstep so the deleted message can't resurrect
    // from IndexedDB on a cold-start reopen (writeCachedMessages drops the row that left the window).
    persistWindowToLocalSync(chatId, filtered)
    await loadChats()
  }, [invalidateMessageSnapshots, loadChats, messagesRef, persistWindowToLocalSync, setMessagesAndCache])

  const appendMessage = useCallback((msg: MessageItem) => {
    // @@@threads (#1114) - 话题回复(thread_root_id 非空)绝不进主时间线(getMessages 过滤掉它):
    // 与 realtime 路由一致,只在该话题正打开时乐观 upsert 进 threadMessages;回复数摘要交 realtime /
    // realtime 维护(不在此 +1,避免双加)。主线消息(thread_root_id null)照旧。
    if (msg.thread_root_id) {
      if (activeThreadRootIdRef.current === msg.thread_root_id) {
        setThreadMessages((prev) => upsertMessageById(prev, msg))
      }
      return
    }
    // @@@prev-bleed-root (#621 layer 2) - the active-vs-cache split now lives in
    // setMessagesAndCache itself, so this is a single unconditional call: it writes the
    // global `messages` when msg.chat_id is active, otherwise updates only that chat's cache.
    setMessagesAndCache((prev) => upsertMessageById(prev, msg), msg.chat_id)
    // @@@4439 — settled 权威行(ack/附件回读/sessionpage host)合并后调度跳号重验证;机制、竞态让位与降级链见 chatSeqJumpRepair 卫星。
    if (msg.seq >= 0) void repairSeqJumpAfterIngest({ userId: () => userRef.current?.id ?? null, windowRows: windowRowsOf, snapshotEpoch: getMessageSnapshotEpoch, revalidateInFlight: revalidateInFlightRef.current, applyMessagesSnapshot, refreshMessages }, msg)
  }, [applyMessagesSnapshot, getMessageSnapshotEpoch, refreshMessages, setMessagesAndCache, windowRowsOf])

  const pinChat = useCallback(async (chatId: string, pinned: boolean) => {
    if (!user) throw new Error('Not authenticated')
    const previousPinned = chatsRef.current.find((chat) => chat.id === chatId)?.is_pinned ?? false
    setChats((prev) => prev.map((c) => c.id === chatId ? { ...c, is_pinned: pinned } : c))
    try {
      await chatService.setChatPinned(chatId, user.id, pinned)
    } catch (err) {
      setChats((prev) => prev.map((c) => c.id === chatId ? { ...c, is_pinned: previousPinned } : c))
      throw err
    }
  }, [user])

  const deleteChat = useCallback(async (chatId: string, persist = false) => {
    if (persist) await chatService.archiveChat(chatId)
    projectionRef.current.forgetChat(chatId) // 显式删除是权威动作:乐观行与投影水位一起出列 (#4314)
    setChats((prev) => prev.filter((c) => c.id !== chatId))
    dropTextDraft(chatId)
    dropDraftAttachments(chatId) // @@@draft-attachment (#1872) - drop queued attachments alongside the draft
    messagesCacheRef.current.delete(chatId)
    if (activeChatIdRef.current === chatId) setActiveChatId(null)
  }, [setActiveChatId, dropDraftAttachments, dropTextDraft])

  // #901 退出群聊：共同 RPC 确认移除本人席位后，再本地清理。
  const leaveGroup = useCallback(async (chatId: string) => {
    if (!user) throw new Error('Not authenticated')
    await chatService.removeGroupMember(chatId, user.id)
    projectionRef.current.forgetChat(chatId) // 同 deleteChat:退出是权威动作 (#4314)
    setChats((prev) => prev.filter((c) => c.id !== chatId))
    dropTextDraft(chatId)
    dropDraftAttachments(chatId) // @@@draft-attachment (#1872) - drop queued attachments alongside the draft
    messagesCacheRef.current.delete(chatId)
    if (activeChatIdRef.current === chatId) setActiveChatId(null)
  }, [user, setActiveChatId, dropDraftAttachments, dropTextDraft])

  const markUnread = useCallback((chatId: string) => markManualUnreadAndRefresh(chatId, { chats: chatsRef.current, patchChat, toast, refresh: loadChats }), [loadChats, patchChat, toast])

  const setChatNotificationLevel = useCallback(async (chatId: string, level: NotificationLevel) => {
    if (!user) throw new Error('Not authenticated')
    const previousChat = chatsRef.current.find((chat) => chat.id === chatId)
    const previousLevel = previousChat?.notification_level ?? 'all'
    const previousMuted = previousChat?.is_muted ?? (previousLevel === 'none')
    setChats((prev) => prev.map((c) => c.id === chatId
      ? { ...c, notification_level: level, is_muted: level === 'none' }
      : c))
    try {
      await chatService.setChatNotificationLevel(chatId, user.id, level)
    } catch (err) {
      setChats((prev) => prev.map((c) => c.id === chatId
        ? { ...c, notification_level: previousLevel, is_muted: previousMuted }
        : c))
      throw err
    }
  }, [user])

  // ── Update macOS Dock badge with total unread count ───────────────────────
  useEffect(() => {
    if (!platform.capabilities.badge) return
    const total = chats.reduce((sum, c) => sum + (c.is_muted ? 0 : c.unread_count), 0)
    platform.setBadge(total)
  }, [chats])

  // @@@1577 M3 — ThreadScope 单一对象:从 granular 字段派生一处内聚真值(主线/话题列表选取只此一份)。
  const threadScope = useMemo(
    () => deriveThreadScope({ rootId: activeThreadRootId, messages, threadMessages, loadingThread, loadingMessages }),
    [activeThreadRootId, messages, threadMessages, loadingThread, loadingMessages],
  )

  // @@@send-outbox — depsRef 每 render 末刷新为最新身份(构造处注释);事件回调时刻解引用。
  outboxDepsRef.current = { setMessagesAndCache, setThreadMessages, patchChat, toast, appendMessage }

  return (
    <ChatStoreProvider
      value={{
        getImRepository,
        subscribeAccountRevision, subscribeChatWindow,
        identitiesById,
        chats,
        activeChatId,
        activeChat,
        messages,
        loadingChats: chatsLoad === 'loading', chatsLoadFailed: chatsLoad === 'failed',
        loadingMessages,
        messagesError: messageReadFailureOf(activeChatId),
        hasMoreOlder,
        loadingOlder,
        messageWindow, unreadNavigationPending: unreadNavigation.navigationPending, loadNewerMessages, loadMessageAnchor, returnToLatestMessages, markMessageVisible,
        memberReadSeqs,
        activeThreadRootId,
        threadMessages,
        loadingThread,
        threadScope,
        openThread,
        openUnreadChat: unreadNavigation.openUnreadChat, unreadEntry: unreadNavigation.unreadEntry, jumpToUnreadEntry: unreadNavigation.jumpToUnreadEntry,
        setActiveChatId,
        sendMessage,
        sendMessageToChat,
        retrySend,
        discardSend,
        toggleReaction,
        refreshChats: loadChats,
        refreshMessages,
        loadOlderMessages,
        setFollowingTail,
        createGroupChat,
        clearMessages,
        removeMessage,
        deleteMessage,
        appendMessage,
        upsertChat,
        pinChat,
        deleteChat,
        leaveGroup,
        markUnread,
        setChatNotificationLevel,
        patchChat,
        ...textDraftContext,
        ...draftMentionContext,
        ...draftAttachmentContext,
      }}
    >
      {children}
    </ChatStoreProvider>
  )
}
