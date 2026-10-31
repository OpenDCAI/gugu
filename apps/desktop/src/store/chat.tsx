import type { UnreadLocatorCommit } from '../lib/chatUnreadLocatorWindow'
import { topicService } from '../lib/topics'
import type { ConversationViewport } from './chatWindowCache'
import { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo, type SetStateAction } from 'react'
import { chatService } from '../lib/chat'
import { isLifecycleCancellation } from '../lib/authBoundedFetch'
import { useAuth } from './auth'
import { useToast, type ToastType } from '../components/toastContext'
import { upsertChatRow } from '@gugu/core/shared/ui/chatModels'
import { unreadAskingYou } from '@gugu/core/shared/ui/notificationModels'
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
import { applyMessageWindowRevalidation } from '../lib/chatMessageRevalidation'
import { platform } from '../platform'
import { createOutboxWiring, type OutboxWiring } from './chatOutboxWiring'
import { markLatestThreadRead, markManualUnreadAndRefresh } from '../lib/chatUnreadLocator'
import { useChatUnreadStreamNavigation } from '../lib/chatUnreadStreamNavigation'
import { ChatStoreProvider, type SendMessageOptions, type SendAttachmentOptions, useDraftAttachmentsStore, useDraftMentionsStore, useTextDraftStore, type RefreshChatsOptions } from './chatContext'
import { advanceReadWatermark, applyThreadSnapshot, fetchOpenThreadSnapshot, patchChatRows, reconcileMemberReadSeqs, type PatchChat } from './chatRealtimeMutations'; import { subscribeChatLineRevisions } from '../lib/accountRevisionListeners'; import { chatOnScreen } from '../lib/onScreenChat'
import { useMessageReadFailures, useMessageSnapshotEpochs } from './chatMessageReads'
import { useChatConversation, type ChatConversationAccess } from './useChatConversation'
import { useActiveChatTransitionState } from './activeChatTransition'; import { fetchChatHistoryPage, restoreChatHistoryAnchor, openCachedChatWindow, useChatWindowCache, type WindowObserver } from './chatWindowPublication'
import {
  INITIAL_PAGE,
  NEWER_PAGE,
  maxMainlineSeq,
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
import { initializeAccountSync } from '../lib/accountSyncSnapshot'
import { subscribeAgentPresenceRevisions } from '../lib/agentPresenceStore'
import { sendAttachmentBatch } from '../components/chat/sendAttachmentBatch'
import { observeAttachmentMessage } from '../lib/attachmentSendRecovery'
import { i18n } from '../i18n'
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
  const [chatsLoad, setChatsLoad] = useState<'unread' | 'idle' | 'loading' | 'failed'>('unread') // unread = 这个号的列表还没读成过;failed = 最近一次读失败了(#2118:空着不是「没有」)
  const { track: trackMessageRead, noteFreshRead: noteFreshMessageRead, failureOf: messageReadFailureOf } = useMessageReadFailures() // #7199 读失败按会话、按最新一次读记
  const { dropTextDraft, ...textDraftContext } = useTextDraftStore()
  const draftMentionContext = useDraftMentionsStore()
  // @@@draft-attachment (#1872) - per-chat queued-attachment store (state/set/get/drop live in the hook).
  const { dropDraftAttachments, ...draftAttachmentContext } = useDraftAttachmentsStore()
  const cancelChatOpenRef = useRef<(chatId: string, error: Error) => void>(() => undefined)
  const unreadNavigationRef = useRef<ReturnType<typeof useChatUnreadStreamNavigation> | null>(null)
  const activeThreadRootIdRef = useRef<string | null>(null)

  // Account facts/read ownership are shared; history and navigation belong to each presenter.
  const { cache } = useChatWindowCache(userId)
  const startConversationRef = useRef<(chatId: string) => () => void>(() => () => undefined)
  const subscribeChatWindow = useCallback<ChatConversationAccess['subscribe']>((chatId, listener, viewport) =>
    cache.subscribe(chatId, listener, () => startConversationRef.current(chatId), viewport), [cache])
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
  // Ref mirrors of state — read by debug bridge (closure-captured at mount time).
  const activeChatIdRef = useRef<string | null>(null)
  const messagesRef = useRef<MessageItem[]>([])
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
  useLayoutEffect(() => { chatsRef.current = chats }, [chats])

  const healCycleCountRef = useRef(0)
  // Install global debug bridge once. Closure captures refs (live values).
  useEffect(() => {
    window.__chatDebug = {
      getHealCycleCount: () => healCycleCountRef.current,
      getActiveChatId: () => activeChatIdRef.current,
      getMessagesCount: () => messagesRef.current.length,
      getLoadingMessages: () => loadingMessagesRef.current,
      getCachedChatIds: () => Array.from(cache.keys()),
      getMessagesCallCount: () =>
        Object.values(chatService._callCountsBySource).reduce((a, b) => a + b, 0),
      getCallCountsBySource: () => ({ ...chatService._callCountsBySource }),
      getRevalidateInFlight: () => Array.from(revalidateInFlightRef.current),
    }
  }, [cache, messagesRef])

  const setMessagesAndCache = useCallback((updater: SetStateAction<MessageItem[]>, chatId: string | null) => {
    if (!chatId) return
    cache.update(chatId, updater)
  }, [cache])
  const memberReadPorts = useCallback((chatId: string) => ({
    memberReadSeqsChatRef: { current: chatId as string | null },
    setMemberReadSeqs: (updater: SetStateAction<Record<string, number>>) => {
      const previous = cache.view(chatId).memberReadSeqs
      cache.patchView(chatId, { memberReadSeqs: typeof updater === 'function' ? updater(previous) : updater })
    },
    readMemberReadSeqs: () => cache.view(chatId).memberReadSeqs,
  }), [cache])
  const setThreadMessagesFor = useCallback((chatId: string, updater: SetStateAction<MessageItem[]>) => {
    const previous = cache.view(chatId).threadMessages
    cache.patchView(chatId, { threadMessages: typeof updater === 'function' ? updater(previous) : updater })
  }, [cache])
  const getImRepository = useCallback(async (): Promise<AccountImRepository> => {
    if (!userId) throw new Error('Cannot open IM repository without an account')
    if (imRepositoryScope.disposed || imRepositoryScope.accountId !== userId) throw new Error(`IM repository scope ${userId} disposed`)
    if (imRepositoryRef.current?.accountId === userId) return imRepositoryRef.current
    if (imRepositoryPromiseRef.current?.accountId === userId) return imRepositoryPromiseRef.current.promise
    const promise = openImRepository(userId, { initialize: initializeAccountSync }).catch((error) => { if (imRepositoryPromiseRef.current?.promise === promise) imRepositoryPromiseRef.current = null; throw error })
    imRepositoryPromiseRef.current = { accountId: userId, promise }
    const repository = await promise
    if (imRepositoryScope.disposed || imRepositoryPromiseRef.current?.promise !== promise) {
      repository.close()
      throw new Error(`IM repository scope ${userId} was disposed or superseded during open`)
    }
    imRepositoryRef.current = repository
    subscribeIdentities(repository, setIdentitiesById)
    return repository
  }, [imRepositoryScope, userId])

  const getRevisionCoordinator = useCallback(async (): Promise<AccountRevisionCoordinator> => {
    if (revisionCoordinatorRef.current) return revisionCoordinatorRef.current
    if (revisionCoordinatorPromiseRef.current) return revisionCoordinatorPromiseRef.current
    const promise = getImRepository().then((repository) => {
      if (!userId || imRepositoryScope.disposed) throw new Error('Account revision scope disposed before start')
      const coordinator = createAccountRevisionCoordinator(
        userId,
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
  }, [getImRepository, imRepositoryScope, userId])

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
      void getImRepository()
        .then((repository) => {
          // Mutators can request persistence inside their updater, before the history controller commits.
          const rows = cache.get(chatId) ?? messages
          const hasMoreOlder = cache.getHistory(chatId)?.getSnapshot().hasOlder ?? (rows.some((row) => row.seq > 1) && !rows.some((row) => row.seq === 1))
          return publishMessageWindow(repository, chatId, rows, hasMoreOlder)
        })
        .catch((err) => console.error('[ChatStore] persist repository message window failed', err))
    },
    [cache, getImRepository],
  )

  // @@@send-outbox (#1762 洞③/#1941) — 发送 outbox 接线。io 依赖全经 outboxDepsRef 惰性委托:wiring
  // 单例首次 render 构造,而 patchChat 等定义在本文件更靠后(直接闭包会 TDZ)——
  // depsRef 在每次 render 末尾(provider return 前)刷新为最新身份,回调只在事件时刻解引用。
  // retrySend/discardSend 经 context 供 MessageSendStatus 直连,无 props 钻孔(冻结文件零增行)。
  const userRef = useRef(user)
  userRef.current = user
  const outboxDepsRef = useRef<{
    setMessagesAndCache: (updater: (prev: MessageItem[]) => MessageItem[], chatId: string) => void
    setThreadMessages: (updater: SetStateAction<MessageItem[]>, chatId: string) => void
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
      activeThreadRootId: (chatId) => chatId ? cache.view(chatId).activeThreadRootId : activeThreadRootIdRef.current,
      setMessagesAndCache: (updater, chatId) => outboxDepsRef.current?.setMessagesAndCache(updater, chatId),
      setThreadMessages: (updater, chatId) => outboxDepsRef.current?.setThreadMessages(updater, chatId),
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
  }, [cache, userId, getImRepository])

  const { epochOf: getMessageSnapshotEpoch, bump: bumpMessageSnapshotEpoch } = useMessageSnapshotEpochs()

  const invalidateMessageSnapshots = useCallback((chatId: string): number => {
    const next = bumpMessageSnapshotEpoch(chatId)
    cache.getHistory(chatId)?.invalidate()
    return next
  }, [bumpMessageSnapshotEpoch, cache])

  /** 当前选中被权威地撤销了。⚠️ 落地那个 await 里用户可能又选了别条 —— 那是**更新的意图**(#4314)。 */
  const onActiveRevoked = useCallback((chatId: string) => {
    invalidateMessageSnapshots(chatId)
    cache.delete(chatId)
    if (activeChatIdRef.current !== chatId) return
    setActiveChatIdState(null)
  }, [cache, invalidateMessageSnapshots, setActiveChatIdState])

  // @@@chat-projection — 会话列表的每一发云端取数都经投影(spec I7 唯一属主):按键取数、按戳 join,
  // 一条通知的代价与账号里有多少会话无关。绑定的三件事在 chatProjectionBinding.ts。
  const chatProjection = useChatProjectionBinding({
    ledger: projectionRef.current, repositoryRef: imRepositoryRef, getRepository: getImRepository,
    chatsRef, activeChatIdRef, requestSeqRef: listRequestSeqRef, setChats, onActiveRevoked,
    notifications: { chatMessages: notificationSettings.chatMessages, sound: notificationSettings.sound },
  })

  const loadChats = useCallback(async (options: RefreshChatsOptions = {}) => {
    if (!userId) return
    const isFirstLoad = chatsRef.current.length === 0
    setChatsLoad((state) => (isFirstLoad ? 'loading' : state === 'failed' || state === 'unread' ? 'idle' : state))
    const requestSeq = ++listRequestSeqRef.current
    try {
      // 冷启快照也走投影(spec I7:会话列表只有一条拉取路)—— 一次「哪些会话属于我」的读 + 同一套族读。
      // ❌ 没有「空了就等 500 ms 再读一遍」那一手:同一游标上重读是重放,投影按 I3 一发都不打
      // (它会原样交回同一份行)。刚建号/刚建会话时成员行**晚一点**提交,命名它的是 journal 的
      // 那条 operation(服务端义务 O1),路径是 wake → advance,不是一次定时轮询。
      const data = await chatProjection.hydrate(userId)
      if (data.length > 0 || chatsRef.current.length === 0 || options.acceptEmpty === true) {
        // 选中一条会话是**用户的意图**,不是列表刷新的投影 —— 什么时候才算「它没了」由账本判(#4314)。
        await chatProjection.publish(data, chatProjection.identities(userId), {
          requestSeq, notify: !isFirstLoad, preserveMissingActive: options.preserveMissingActive,
        })
      }
    } catch (err) {
      if (!isLifecycleCancellation(err)) { console.error('[ChatStore] loadChats error', err); setChatsLoad('failed') } // #2187 取消≠失败
      if (options.throwOnError) throw err
    } finally {
      setChatsLoad((state) => (state === 'loading' ? 'idle' : state))
    }
  }, [chatProjection, userId])

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

  const applyFreshMessageSnapshot = useCallback((chatId: string, msgs: MessageItem[], epoch: number): MessageItem[] | null => {
    if (epoch !== getMessageSnapshotEpoch(chatId)) return null
    cache.set(chatId, msgs)
    const nextMessages = cache.get(chatId) ?? []
    // @@@msg-cache (#621/P2/#947) - write-through L2: this is the canonical window-commit point for
    // initialLoad / loadNewer / toggleReaction / refreshMessages, so persisting here keeps the durable
    // cache in lockstep with L1 (same contract as cache.set above).
    persistWindowToLocalSync(chatId, nextMessages)
    return nextMessages
  }, [cache, getMessageSnapshotEpoch, persistWindowToLocalSync])

  /** 返回 false = 未落窗(未登录或快照 epoch 已变被拒收)。 */
  const applyMessagesSnapshot = useCallback((chatId: string, msgs: MessageItem[], readSeqs: Record<string, number> | null, epoch: number): boolean => {
    if (!userId) return false
    const nextMessages = applyFreshMessageSnapshot(chatId, msgs, epoch)
    if (!nextMessages) return false
    const stillActive = cache.isObserved(chatId)
    // #1529 单调 reconcile(唯一实现在卫星,与 heal 无增量分支共用)。
    if (stillActive && readSeqs) reconcileMemberReadSeqs(chatId, readSeqs, memberReadPorts(chatId)) // null = 载荷无水位,别动表(#5649)
    const lastPersistedSeq = Math.max(0, ...nextMessages.map((msg) => msg.seq).filter((seq) => seq >= 0))
    if (stillActive && chatOnScreen() === chatId && cache.isFollowingTail(chatId) && lastPersistedSeq > 0 && !unreadNavigationRef.current?.ownsChat(chatId)) advanceReadWatermark(chatsRef.current, chatId, lastPersistedSeq, patchChat)
    return true
  }, [applyFreshMessageSnapshot, cache, memberReadPorts, patchChat, userId])

  // ── #621 incremental spine ────────────────────────────────────────────────
  const windowRowsOf = useCallback((chatId: string) => cache.rows(chatId), [cache])
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
      if (!userId) return
      const epoch = getMessageSnapshotEpoch(chatId)
      const cached = cache.rows(chatId)
      if (!cached || cached.length === 0) return
      const ids = cached.filter((m) => m.seq >= 0).map((m) => m.id)
      if (ids.length === 0) return
      try {
        const revalidation = await chatService.revalidateWindow(ids, userId)
        if (epoch !== getMessageSnapshotEpoch(chatId) || imRepositoryScope.disposed) return
        const queriedIds = new Set(ids)
        setMessagesAndCache((rows) => applyMessageWindowRevalidation(rows, queriedIds, revalidation), chatId)
        persistWindowToLocalSync(chatId, cache.get(chatId) ?? [])
      } catch (err) {
        if (!isLifecycleCancellation(err)) console.error('[ChatStore] revalidateWindowOverlays failed', err) // #2187 取消≠失败
        if (throwOnError) throw err
      }
    },
    [cache, getMessageSnapshotEpoch, imRepositoryScope, persistWindowToLocalSync, setMessagesAndCache, userId],
  )
  const refreshMessages = useCallback(async (chatId = activeChatIdRef.current ?? undefined) => {
    if (!chatId || !userId) return
    const epoch = getMessageSnapshotEpoch(chatId)
    revalidateInFlightRef.current.add(chatId)
    try {
      const [msgs, readSeqs] = await trackMessageRead(chatId, Promise.all([
        chatService.getMessages(chatId, userId, 'initialLoad', INITIAL_PAGE),
        chatService.getOtherMembersReadSeqs(chatId, userId),
      ]))
      applyMessagesSnapshot(chatId, msgs, readSeqs, epoch)
      await revalidateWindowOverlays(chatId)
    } finally {
      revalidateInFlightRef.current.delete(chatId)
    }
  }, [applyMessagesSnapshot, getMessageSnapshotEpoch, trackMessageRead, revalidateWindowOverlays, userId])

  // @@@1888 — resubscribe = 重验证:增量 delta(seq > 主线缓存 max)直接问服务端,**结果即真值**——
  // 空 = 无 gap;短页 = 补齐;整页 = 断档可能超一页 → 交给 refreshMessages 权威重载(#621 既有
  // degrade 原语,判定在结果侧,不做预测)。此前用 chatsRef 的 next_message_seq 做客户端 gap 预测,
  // 重连时恰恰是它最 stale 的时刻(且它计入话题 seq、与主线 cursor 单位错配 → 假 gap 恒真),按预测
  // 跳过的 heal 会静默漏消息——预测层删除,勿再引入。并发语义:重连风暴下同 chat 的多次 heal
  // 幂等收敛(同 cursor 的 delta + epoch 门 + 单调 merge + chokepoint 水位),重复代价 = 有界查询,
  // 且已被订阅层重连退避(RECONNECT_DELAYS)限流,故不设去重机制。
  const healMessageGap = useCallback(
    async (chatId: string, throwOnError = false) => {
      if (!userId) return
      const maxSeq = maxSeqOf(chatId)
      const epoch = getMessageSnapshotEpoch(chatId)
      revalidateInFlightRef.current.add(chatId)
      try {
        // @@@5856 原来这里还并行拉一次 chat.thread_summaries。群 thread 面板退役后没有任何 surface
        // 读它 —— 每开一次会话白跑一次往返。话题是**另一条 chat**,它的摘要不在这条线的聚合里。
        const [threadSnap, msgs, readSeqs] = await Promise.all([
          cache.isObserved(chatId) ? fetchOpenThreadSnapshot({ chatId, userId: userId, activeThreadRootId: () => cache.view(chatId).activeThreadRootId }) : null,
          chatService.getMessages(chatId, userId, 'loadNewer', NEWER_PAGE, undefined, maxSeq),
          chatService.getOtherMembersReadSeqs(chatId, userId),
        ])
        // R6 被新快照取代的补洞结果不许静默丢:会话仍在屏上就抛错,让修订派发重补。
        if (msgs.length > 0) commitHealedMessages({ chatId, apply: () => applyMessagesSnapshot(chatId, msgs, readSeqs, epoch), stillActive: () => cache.isObserved(chatId) })
        else if (cache.isObserved(chatId)) reconcileMemberReadSeqs(chatId, readSeqs, memberReadPorts(chatId))
        if (msgs.length >= NEWER_PAGE) await refreshMessages(chatId)
        if (threadSnap) {
          applyThreadSnapshot({ chatId, ...threadSnap, chats: chatsRef.current, setThreadMessages: (update) => setThreadMessagesFor(chatId, update), patchChat,
            activeChatId: () => cache.isObserved(chatId) ? chatId : null, activeThreadRootId: () => cache.view(chatId).activeThreadRootId })
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
    [applyMessagesSnapshot, cache, getMessageSnapshotEpoch, maxSeqOf, memberReadPorts, noteFreshMessageRead, patchChat, refreshMessages, revalidateWindowOverlays, setThreadMessagesFor, userId],
  )
  const loadHistoryPage = useCallback(async (direction: 'older' | 'newer' | 'latest', chatId = activeChatIdRef.current, viewport?: ConversationViewport) => {
    if (!userId || !chatId) return
    const targetWindow = cache.history(chatId, viewport)
    try {
      const changed = await targetWindow.load(direction, fetchChatHistoryPage(userId))
      const window = targetWindow.getSnapshot()
      if (changed && window.chatId) {
        if (direction === 'latest') cache.establishTail(window.chatId, window.messages)
        else cache.update(window.chatId, (rows) => mergeMessagesById(rows, window.messages, window.chatId!))
        persistWindowToLocalSync(window.chatId, cache.get(window.chatId) ?? []); await revalidateWindowOverlays(window.chatId)
      }
      if (direction !== 'older' && window.chatId) noteFreshMessageRead(window.chatId) // #7199 往新翻 / 回到最新成了:读得到最新的了
    } catch (err) {
      if (!isLifecycleCancellation(err)) console.error('[ChatStore] history page failed', err)
      throw err
    }
  }, [userId, cache, noteFreshMessageRead, persistWindowToLocalSync, revalidateWindowOverlays])
  const loadMessageAnchor = useCallback(async (messageId: string, targetChatId = activeChatIdRef.current, viewport?: ConversationViewport, commit?: UnreadLocatorCommit) => {
    if (!userId || !targetChatId) return
    const targetWindow = cache.history(targetChatId, viewport)
    const changed = commit ? await targetWindow.restoreAnchor(async () => ({ messages: commit.rows, hasNewer: !commit.reachedTail })) : await restoreChatHistoryAnchor(targetWindow, userId, messageId)
    if (changed) {
      const window = targetWindow.getSnapshot()
      if (!window.hasNewer) cache.establishTail(targetChatId, window.messages)
      else cache.update(targetChatId, (rows) => mergeMessagesById(rows, window.messages, targetChatId))
      persistWindowToLocalSync(targetChatId, cache.get(targetChatId) ?? []); await revalidateWindowOverlays(targetChatId)
    }
  }, [userId, cache, persistWindowToLocalSync, revalidateWindowOverlays])
  const markMessageVisible = useCallback((message: MessageItem) => {
    const chatId = message.chat_id
    if (!userId || !cache.isObserved(chatId)) return
    const receipts = cache.readReceipts(chatId)
    if (message.seq > 0 && !message.is_mine && !message.thread_root_id && !unreadNavigationRef.current?.ownsChat(chatId)
      && cache.rows(chatId).some((row) => row.id === message.id)) {
      const chat = chatsRef.current.find((row) => row.id === chatId)
      if (chat && message.seq > chat.last_read_seq)
        advanceReadWatermark(chatsRef.current, chatId, message.seq, patchChat, { unread_count: chat.unread_count, unread_locator: chat.unread_locator })
    }
    if (!message.to_user_ids?.includes(userId) || message.sender_user_id === userId
      || message.delivery_status === 'read' || receipts.has(message.id)) return
    receipts.add(message.id)
    void chatService.markMessageRead(chatId, message.id, userId).catch((error: unknown) => {
      receipts.delete(message.id)
      // The realtime row can arrive before the read RPC can see its transaction.
      if (/not found in chat/i.test(error instanceof Error ? error.message : String(error))) return
      revisionLog.warn({ error, chatId }, 'markMessageRead failed')
    })
  }, [cache, patchChat, userId])

  useEffect(() => {
    if (!userId) {
      setChats([]); setChatsLoad('unread') // 换号 / 登出:上一个号的读失败 ❌ 带到下一个号的「群」那一格
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
  }, [getImRepository, loadChats, userId])

  useEffect(() => {
    if (!userId || !imRepositoryRef.current) return
    void replaceChatRows(imRepositoryRef.current, chats)
      .catch((err) => console.error('[ChatStore] persist repository chats failed', err))
  }, [chats, userId])

  // ── Subscribe to durable account revisions ─────────────────────────────────
  useEffect(() => {
    if (!userId) return
    const unsubscribes = [
      // @@@chat-projection — 投影认领它那组 event 并自己合批:一次 wake = 一次推进。从前这里每类
      // event 各自 `loadChats()`(整账号 8 波重拉),一条新消息就能打出 40 环串行(#5394)。
      chatProjection.attach(userId, subscribeAccountRevision),
      // 在线状态的属主是 agentPresenceStore,不是会话列表:**不同状态的两个属主**,不是一份状态两条路。
      subscribeAgentPresenceRevisions(subscribeAccountRevision),
      // These surfaces own no durable list while closed: opening them always performs an authoritative
      // fetch. Keep a mounted owner so an operation for a closed surface cannot head-of-line block the
      // account inbox; when the surface is open its scoped listener runs in the same dispatch.
      subscribeAccountRevision('group_collab_changed', () => undefined),
      subscribeAccountRevision('workspace_changed', () => undefined),
    ]
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe()
    }
  }, [userId, chatProjection, subscribeAccountRevision])

  const readChatWindow = useCallback((chatId: string) => {
    if (imRepositoryRef.current?.accountId === userId) seedCacheFromDisk(cache, imRepositoryRef.current, chatId)
    return cache.get(chatId)
  }, [cache, userId])
  const openMessageWindow = useCallback(async (chatId: string, observer: WindowObserver) => {
    if (!userId) return
    const epoch = getMessageSnapshotEpoch(chatId)
    const chat = chatsRef.current.find((row) => row.id === chatId)
    const current = () => !imRepositoryScope.disposed && epoch === getMessageSnapshotEpoch(chatId) && observer.current()
    revalidateInFlightRef.current.add(chatId)
    try {
      await openCachedChatWindow({
        chatId, userId: userId, cache, getRepository: getImRepository,
        history: cache.history(chatId),
        expectedTailSeq: chat ? expectedTailSeq(chatId) : null, hasPositiveUnread: (chat?.unread_count ?? 0) > 0,
        observer: { ...observer, current },
        commit: (rows, replaceTail, hasOlder) => {
          if (replaceTail) cache.establishTail(chatId, rows)
          if (hasOlder !== undefined) cache.history(chatId).setHasOlder(hasOlder)
          applyMessagesSnapshot(chatId, rows, null, epoch)
        },
        revalidate: () => revalidateWindowOverlays(chatId),
      })
    } finally { revalidateInFlightRef.current.delete(chatId) }
  }, [applyMessagesSnapshot, cache, expectedTailSeq, getImRepository, getMessageSnapshotEpoch, imRepositoryScope, revalidateWindowOverlays, userId])
  // One read and revision owner per observed chat, shared by every surface.
  startConversationRef.current = (chatId) => {
    if (!userId) return () => undefined
    let cancelled = false
    unreadNavigationRef.current?.beginChatOpen(chatId)
    cache.patchView(chatId, { loading: !cache.get(chatId)?.length })
    const ready = (error?: Error) => {
      if (cancelled) return
      cache.patchView(chatId, { loading: false })
      unreadNavigationRef.current?.finishChatOpen(chatId, error)
    }
    void trackMessageRead(chatId, openMessageWindow(chatId, {
      current: () => !cancelled,
      painted: () => cache.patchView(chatId, { loading: false }), ready: () => ready(),
      readSeqs: (seqs) => { if (!cancelled) reconcileMemberReadSeqs(chatId, seqs, memberReadPorts(chatId)) },
    })).then(() => ready()).catch((error: unknown) => {
      if (!isLifecycleCancellation(error)) console.error('[ChatStore] load messages error', error)
      ready(error instanceof Error ? error : new Error(String(error)))
    })
    const stop = subscribeChatLineRevisions(subscribeAccountRevision, {
      userId: userId!, chatId: () => cancelled ? null : chatId,
      maxSeqOf, getMessageSnapshotEpoch, applyMessagesSnapshot, healMessageGap, revalidateWindowOverlays,
      setMessagesAndCache, persistWindowToLocalSync, setThreadMessages: (update) => setThreadMessagesFor(chatId, update),
      ...memberReadPorts(chatId),
    })
    return () => {
      cancelled = true
      bumpMessageSnapshotEpoch(chatId)
      stop()
      unreadNavigationRef.current?.cancelChatOpen(chatId, new Error(`Chat ${chatId} is no longer observed`))
    }
  }
  useEffect(() => userId ? subscribeAccountRevision('gugu_decision_event', () => loadChats({ acceptEmpty: true, throwOnError: true })) : undefined,
    [userId, loadChats, subscribeAccountRevision])

  // ── Actions ────────────────────────────────────────────────────────────────
  const setActiveChatId = useCallback((id: string | null) => {
    if (activeChatIdRef.current === id) return
    activeChatIdRef.current = id
    setActiveChatIdState(id)
    if (id) readChatWindow(id)
  }, [readChatWindow, setActiveChatIdState])

  const unreadNavigation = useChatUnreadStreamNavigation({ user, chatsRef, activeChatIdRef, threadRootOf: (id) => cache.view(id).activeThreadRootId,
    getMessageSnapshotEpoch, setActiveChatId,
    isChatOpen: (id) => cache.isObserved(id),
    setActiveThreadRootId: (rootId, id) => cache.patchView(id, { activeThreadRootId: rootId }),
    setLoadingThread: (loading, id) => cache.patchView(id, { loadingThread: loading }),
    setThreadMessages: (update, id) => setThreadMessagesFor(id, update),
    loadChats, cancelChatOpenRef })
  unreadNavigationRef.current = unreadNavigation
  // @@@threads — 打开/关闭话题视图。传 rootId 打开并拉取该话题的 root+回复；传 null 回主时间线。
  const openThread = useCallback((rootId: string | null, chatId = activeChatIdRef.current) => {
    if (!chatId) return
    cache.patchView(chatId, { activeThreadRootId: rootId })
    if (!rootId || !userId) {
      setThreadMessagesFor(chatId, [])
      cache.patchView(chatId, { loadingThread: false }) // 关话题时清掉(防上一话题 fetch 在途时关闭→loading 卡 true)
      return
    }
    // @@@threads (#1196 Q2) — 开 thread 即标 root（ruling A）：乐观把主线该消息标 is_thread_root
    // → 立刻显 tanchor，不等首条回复；再持久化(mark_thread_root RPC，幂等 best-effort)。已是 root 则无副作用。
    setMessagesAndCache(
      (prev) => prev.map((m) => (m.id === rootId && !m.is_thread_root ? { ...m, is_thread_root: true } : m)),
      chatId,
    )
    void chatService.markThreadRoot(chatId, rootId).catch((err) => console.error('[ChatStore] markThreadRoot error', err))
    cache.patchView(chatId, { loadingThread: true })
    setThreadMessagesFor(chatId, [])
    void (async () => {
      try {
        const msgs = await chatService.getThreadMessages(chatId, rootId, userId)
        // 落地+竞态守卫+@@@1886 开话题即推水位——与 heal 的话题落地共用卫星实现(乐观行保留)。
        applyThreadSnapshot({ chatId, rootId, msgs, chats: chatsRef.current, setThreadMessages: (update) => setThreadMessagesFor(chatId, update), patchChat,
          activeChatId: () => cache.isObserved(chatId) ? chatId : null, activeThreadRootId: () => cache.view(chatId).activeThreadRootId })
        if (!unreadNavigationRef.current?.ownsThread(chatId, rootId)) markLatestThreadRead(chatId, rootId, msgs)
        outboxRef.current?.injectThreadOutboxRows(chatId, rootId) // #1762 洞③ 恢复的未决话题行注入
      } catch (err) {
        console.error('[ChatStore] openThread error', err)
      } finally {
        if (cache.view(chatId).activeThreadRootId === rootId) cache.patchView(chatId, { loadingThread: false })
      }
    })()
  }, [cache, userId, setMessagesAndCache, setThreadMessagesFor, patchChat])
  const sendMessageToChat = useCallback(
    async (
      targetChatId: string,
      content: string,
      opts: SendMessageOptions = {},
      viewport?: ConversationViewport
    ) => {
      if (!targetChatId || !userId || !content.trim()) return
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
        sender_user_id: userId,
        to_user_ids: toUserIds,
        // @@@whisper (#820) - optimistic whisper styling without waiting for the server echo
        is_whisper: !!opts.isWhisper,
        seq: -1,
        content: content.trim(),
        content_type: 'text',
        ...optimisticReplyFields(cache.rows(targetChatId), opts.replyToMessageId ?? null), // @@@2015 乐观回复带全引用预览,回声前空名会触发 #1624
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
        setThreadMessagesFor(targetChatId, (prev) => [...prev, tempMsg])
      } else {
        // C3 发送把窗口钉回底部:含尾的窗口立即恢复跟尾(确认行按尾巴接上,不被当成窗口外丢掉);
        // 离尾的历史段先拉最新页(页里保留这条乐观行及其确认行)。已在拉就不重开。
        const targetWindow = cache.history(targetChatId, viewport)
        if (!targetWindow.followForSend() && targetWindow.getSnapshot().loading !== 'latest') {
          void loadHistoryPage('latest', targetChatId, viewport).catch((error) => revisionLog.error({ error }, 'pin to latest on send failed'))
        }
        setMessagesAndCache((prev) => [...prev, tempMsg], targetChatId)
      }

      // @@@send-outbox (#1762 洞③/#1941) — 入队即返回(resolve ≠ 已送达):投递/超时/退避重试/失败
      // 可见性全归 outbox(唯一 chokepoint);送达连带动作(权威 row/水位/预览/agent 运行态点亮)在
      // wiring.onSent,实时发送与 reload 恢复投递同一条路径。
      try {
        await outboxRef.current!.enqueue({
          id, chatId: targetChatId, senderUserId: userId, content: content.trim(),
          toUserIds, replyToMessageId: opts.replyToMessageId ?? null,
          threadRootId, isThreadRoot: !!opts.isThreadRoot, isWhisper: !!opts.isWhisper,
          resolveDmPeer, beforeDeliver: opts.beforeDeliver, submittedAt: opts.submittedAt,
        })
      } catch (error) {
        if (threadRootId) {
          setThreadMessagesFor(targetChatId, (prev) => prev.filter((message) => message.id !== id))
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
    [userId, cache, setMessagesAndCache, setThreadMessagesFor, loadHistoryPage],
  )

  // @@@send-outbox — failed 态的重试/丢弃(MessageSendStatus 经 context 直连)。
  const retrySend = useCallback((messageId: string) => { outboxRef.current?.retrySend(messageId) }, [])
  const discardSend = useCallback((messageId: string) => { outboxRef.current?.discardSend(messageId) }, [])

  const toggleReaction = useCallback(
    async (messageId: string, emoji: string, chatId = activeChatIdRef.current) => {
      if (!userId || !chatId) return
      const epoch = getMessageSnapshotEpoch(chatId)
      await chatService.toggleReaction(messageId, userId, emoji)
      const msgs = await chatService.getMessages(chatId, userId, 'toggleReaction')
      applyFreshMessageSnapshot(chatId, msgs, epoch)
      await revalidateWindowOverlays(chatId)
    },
    [applyFreshMessageSnapshot, getMessageSnapshotEpoch, revalidateWindowOverlays, userId],
  )

  const createGroupChat = useGroupCreation({ userId, loadChats, setChats, toast })

  const clearMessages = useCallback(async (chatId = activeChatIdRef.current) => {
    if (!chatId) return
    // @@@mutation-window - first invalidate older snapshots, then invalidate snapshots started while the RPC was in flight.
    invalidateMessageSnapshots(chatId)
    await chatService.clearMessagesForMe(chatId)
    invalidateMessageSnapshots(chatId)
    cache.delete(chatId)
    // @@@msg-cache (#947) - clear the durable L2 window too, else a cold-start reopen would resurrect the
    // cleared messages from IndexedDB (write-through here keeps L2 in lockstep with the now-empty L1).
    persistWindowToLocalSync(chatId, [])
  }, [cache, invalidateMessageSnapshots, persistWindowToLocalSync])

  const removeMessage = useCallback((messageId: string, chatId = activeChatIdRef.current) => {
    if (chatId) { setMessagesAndCache((rows) => rows.filter((row) => row.id !== messageId), chatId); persistWindowToLocalSync(chatId, cache.get(chatId) ?? []) }
  }, [cache, persistWindowToLocalSync, setMessagesAndCache])
  const deleteMessage = useCallback(async (messageId: string, targetChatId = activeChatIdRef.current) => {
    if (targetChatId) invalidateMessageSnapshots(targetChatId)
    const { chatId } = await chatService.deleteMessage(messageId)
    invalidateMessageSnapshots(chatId)
    removeMessage(messageId, chatId)
    await loadChats()
  }, [invalidateMessageSnapshots, loadChats, removeMessage])

  const appendMessage = useCallback((msg: MessageItem) => {
    // @@@threads (#1114) - 话题回复(thread_root_id 非空)绝不进主时间线(getMessages 过滤掉它):
    // 与 realtime 路由一致,只在该话题正打开时乐观 upsert 进 threadMessages;回复数摘要交 realtime /
    // realtime 维护(不在此 +1,避免双加)。主线消息(thread_root_id null)照旧。
    if (msg.thread_root_id) {
      if (cache.getHistory(msg.chat_id) && cache.view(msg.chat_id).activeThreadRootId === msg.thread_root_id) {
        setThreadMessagesFor(msg.chat_id, (prev) => upsertMessageById(prev, msg))
      }
      return
    }
    // @@@prev-bleed-root (#621 layer 2) - the active-vs-cache split now lives in
    // setMessagesAndCache itself, so this is a single unconditional call: it writes the
    // global `messages` when msg.chat_id is active, otherwise updates only that chat's cache.
    setMessagesAndCache((prev) => upsertMessageById(prev, msg), msg.chat_id)
    // @@@4439 — settled 权威行(ack/附件回读/sessionpage host)合并后调度跳号重验证;机制、竞态让位与降级链见 chatSeqJumpRepair 卫星。
    if (msg.seq >= 0) void repairSeqJumpAfterIngest({ userId: () => userRef.current?.id ?? null, windowRows: windowRowsOf, snapshotEpoch: getMessageSnapshotEpoch, revalidateInFlight: revalidateInFlightRef.current, applyMessagesSnapshot, refreshMessages, revalidateWindowOverlays }, msg)
  }, [applyMessagesSnapshot, cache, getMessageSnapshotEpoch, refreshMessages, revalidateWindowOverlays, setMessagesAndCache, setThreadMessagesFor, windowRowsOf])

  const sendAttachmentsToChat = useCallback(async (chatId: string | null, files: File[], opts: SendAttachmentOptions = {}, viewport?: ConversationViewport) => {
    if (!files.length) return undefined
    if (!chatId || !userId) throw new Error(i18n.t('composer.attachmentContextMissing', { ns: 'messaging' }))
    const chat = chatsRef.current.find((row) => row.id === chatId)
    const toUserIds = opts.toUserIds?.length ? opts.toUserIds
      : (chat?.kind === 'dm' || chat?.kind === 'ai') && chat.peer_user_id ? [chat.peer_user_id] : null
    if (!opts.threadRootId) {
      if (!cache.history(chatId, viewport).followForSend()) await loadHistoryPage('latest', chatId, viewport)
    }
    return sendAttachmentBatch({ ...opts, files, chatId, senderId: userId, toUserIds, appendMessage,
      observeMessage: observeAttachmentMessage(subscribeAccountRevision, userId, chatId), removePlaceholder: (id) => removeMessage(id, chatId) })
  }, [userId, cache, loadHistoryPage, appendMessage, removeMessage, subscribeAccountRevision])

  const pinChat = useCallback(async (chatId: string, pinned: boolean) => {
    if (!userId) throw new Error('Not authenticated')
    const previousPinned = chatsRef.current.find((chat) => chat.id === chatId)?.is_pinned ?? false
    setChats((prev) => prev.map((c) => c.id === chatId ? { ...c, is_pinned: pinned } : c))
    try {
      await chatService.setChatPinned(chatId, userId, pinned)
    } catch (err) {
      setChats((prev) => prev.map((c) => c.id === chatId ? { ...c, is_pinned: previousPinned } : c))
      throw err
    }
  }, [userId])

  const deleteChat = useCallback(async (chatId: string, persist = false) => {
    if (persist) await (chatsRef.current.find((chat) => chat.id === chatId)?.kind === 'topic' ? topicService.archiveTopic(chatId) : chatService.archiveChat(chatId))
    projectionRef.current.forgetChat(chatId) // 显式删除是权威动作:乐观行与投影水位一起出列 (#4314)
    setChats((prev) => prev.filter((c) => c.id !== chatId))
    dropTextDraft(chatId)
    dropDraftAttachments(chatId) // @@@draft-attachment (#1872) - drop queued attachments alongside the draft
    cache.delete(chatId)
    if (activeChatIdRef.current === chatId) setActiveChatId(null)
  }, [cache, setActiveChatId, dropDraftAttachments, dropTextDraft])
  // #901 退出群聊：共同 RPC 确认移除本人席位后，再本地清理。
  const leaveGroup = useCallback(async (chatId: string) => {
    if (!userId) throw new Error('Not authenticated')
    await chatService.removeGroupMember(chatId, userId)
    projectionRef.current.forgetChat(chatId) // 同 deleteChat:退出是权威动作 (#4314)
    setChats((prev) => prev.filter((c) => c.id !== chatId))
    dropTextDraft(chatId)
    dropDraftAttachments(chatId) // @@@draft-attachment (#1872) - drop queued attachments alongside the draft
    cache.delete(chatId)
    if (activeChatIdRef.current === chatId) setActiveChatId(null)
  }, [cache, userId, setActiveChatId, dropDraftAttachments, dropTextDraft])

  const markUnread = useCallback((chatId: string) => markManualUnreadAndRefresh(chatId, { chats: chatsRef.current, patchChat, toast, refresh: loadChats }), [loadChats, patchChat, toast])

  const setChatNotificationLevel = useCallback(async (chatId: string, level: NotificationLevel) => {
    if (!userId) throw new Error('Not authenticated')
    const previousChat = chatsRef.current.find((chat) => chat.id === chatId)
    const previousLevel = previousChat?.notification_level ?? 'all'
    const previousMuted = previousChat?.is_muted ?? (previousLevel === 'none')
    setChats((prev) => prev.map((c) => c.id === chatId
      ? { ...c, notification_level: level, is_muted: level === 'none' }
      : c))
    try {
      await chatService.setChatNotificationLevel(chatId, userId, level)
    } catch (err) {
      setChats((prev) => prev.map((c) => c.id === chatId
        ? { ...c, notification_level: previousLevel, is_muted: previousMuted }
        : c))
      throw err
    }
  }, [userId])

  // ── Dock / 托盘角标:与通知同一把尺 —— 群与话题只算叫到你的；列表内仍安静显示全部未读 ──────
  useEffect(() => {
    if (!platform.capabilities.badge) return
    platform.setBadge(chats.reduce((sum, c) => sum + unreadAskingYou(c), 0))
  }, [chats])

  const conversationActions = useCallback<ChatConversationAccess['actions']>((chatId, viewport = {}) => ({
    sendAttachments: (files, options) => {
      if (chatId) cache.setFollowingTail(chatId, viewport, true)
      return sendAttachmentsToChat(chatId, files, options, viewport)
    },
    sendMessage: (content, options) => {
      if (!chatId) return Promise.resolve(undefined)
      cache.setFollowingTail(chatId, viewport, true)
      return sendMessageToChat(chatId, content, options, viewport)
    },
    toggleReaction: (id, emoji) => toggleReaction(id, emoji, chatId),
    refreshMessages: (target = chatId ?? undefined) => refreshMessages(target),
    loadOlderMessages: () => loadHistoryPage('older', chatId, viewport), loadNewerMessages: () => loadHistoryPage('newer', chatId, viewport),
    loadMessageAnchor: (id, commit) => loadMessageAnchor(id, chatId, viewport, commit), returnToLatestMessages: () => loadHistoryPage('latest', chatId, viewport),
    markMessageVisible,
    clearMessages: () => clearMessages(chatId), removeMessage: (id) => removeMessage(id, chatId),
    deleteMessage: (id) => deleteMessage(id, chatId), appendMessage, openThread: (rootId) => openThread(rootId, chatId),
    openUnreadChat: unreadNavigation.openUnreadChat,
    unreadEntry: unreadNavigation.entryFor(chatId),
    jumpToUnreadEntry: (viewport) => unreadNavigation.jumpToUnreadEntry(chatId, viewport),
  }), [cache, sendAttachmentsToChat, sendMessageToChat, toggleReaction, refreshMessages, loadHistoryPage, loadMessageAnchor,
    markMessageVisible, clearMessages, removeMessage, deleteMessage, appendMessage, openThread, unreadNavigation])
  const conversations = useMemo<ChatConversationAccess>(() => ({
    read: (id, viewport) => { readChatWindow(id); return cache.view(id, viewport) }, subscribe: subscribeChatWindow,
    actions: conversationActions, setFollowingTail: cache.setFollowingTail, errorOf: messageReadFailureOf,
  }), [cache, readChatWindow, subscribeChatWindow, conversationActions, messageReadFailureOf])
  const line = useChatConversation(activeChatId, conversations)
  const activeChat = chats.find((chat) => chat.id === activeChatId) ?? null
  messagesRef.current = line.messages
  loadingMessagesRef.current = line.loadingMessages
  hasMoreOlderRef.current = line.hasMoreOlder
  activeThreadRootIdRef.current = line.activeThreadRootId
  outboxDepsRef.current = { setMessagesAndCache, setThreadMessages: (update, id) => setThreadMessagesFor(id, update), patchChat, toast, appendMessage }

  return (
    <ChatStoreProvider
      value={{
        getImRepository,
        subscribeAccountRevision, conversations,
        identitiesById,
        chats,
        activeChatId,
        activeChat,
        ...line,
        loadingChats: chatsLoad === 'loading', chatsLoadFailed: chatsLoad === 'failed', chatsRead: chatsLoad === 'idle',
        setActiveChatId,
        sendMessageToChat,
        retrySend,
        discardSend,
        refreshChats: loadChats,
        createGroupChat,
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
