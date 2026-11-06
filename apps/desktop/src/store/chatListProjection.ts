import { useCallback, useMemo, useRef, type MutableRefObject } from 'react'
import { mergeFetchedChatsPreservingActiveLocal } from '@gugu/core/shared/ui/chatModels'
import { createChatNotificationPayload, shouldNotify } from '@gugu/core/shared/ui/notificationModels'
import type { ChatItem, MessageItem } from '@gugu/core/shared/types/chat'
import { publishChatSnapshot } from '../lib/chatSnapshotPublication'
import { platform } from '../platform'
import { isChatOnScreen } from '../lib/onScreenChat'
import { chatPreviewText } from '../lib/agentTurnFailure'
import { imSelectors, type AccountImRepository } from '../lib/imRepository'
import type { PersonalConversationDeletion } from '../lib/deleteListedConversation'
import { patchChatRows, prepareProjectedReadWatermark, type PatchChat } from './chatRealtimeMutations'
import { currentAuthSessionSignal } from '../lib/authSessionLoss'
import {
  createChatProjection, readProjectionCursor,
  type ChatProjection, type ChatProjectionAttachment,
} from '../lib/chatProjection'
import { shareRows } from '../lib/chatProjectionAlgebra'

// @@@selection-is-intent (#4314) — 一次刷新没提到某条会话，含义取决于这一发相对「最后一次看见它」有多新：
// 刚 open_dm 出来的会话还没被任何一发投影过，对它的沉默是仪器还没读到、不是阴性读数。契约见 [[conversation-data]]。
export type ChatListProjectionLedger = ReturnType<typeof createChatListProjectionLedger>

export function createChatListProjectionLedger() {
  const lastSeenSeq = new Map<string, number>()
  const optimistic = new Map<string, ChatItem>()
  return {
    /** 冷启动播种：durable snapshot 是上一次会话的服务端投影。 */
    seedFromCache(chats: readonly ChatItem[]) { for (const c of chats) if (!lastSeenSeq.has(c.id)) lastSeenSeq.set(c.id, 0) },
    recordProjected(chats: readonly ChatItem[], requestSeq: number) {
      for (const c of chats) if ((lastSeenSeq.get(c.id) ?? 0) < requestSeq) lastSeenSeq.set(c.id, requestSeq)
    },
    /** 撤销要三条同时成立：调用方显式放弃保留、这一发没看见它、且这份沉默比最后一次看见它更新。 */
    shouldRevokeActive({ activeChatId, fetched, requestSeq, preserveMissingActive }: {
      activeChatId: string | null; fetched: readonly ChatItem[]; requestSeq: number; preserveMissingActive?: boolean
    }) {
      if (!activeChatId || preserveMissingActive !== false) return false
      if (fetched.some((c) => c.id === activeChatId)) return false
      const seenSeq = lastSeenSeq.get(activeChatId)
      return seenSeq !== undefined && seenSeq < requestSeq
    },
    /** 调用方确知已存在、服务端还没投影出来的行：每次列表落地补回去，被投影出来那一刻自己出列。 */
    rememberOptimistic(chat: ChatItem) { optimistic.set(chat.id, chat) },
    /** 权威地离场(删会话/退群/确证失去访问权):乐观行与「最后一次看见它」的水位一起丢弃 —— 之后它若以同一 id 回来,对它的沉默不再有资格撤销 (#4314)。 */
    forgetChat(chatId: string) { optimistic.delete(chatId); lastSeenSeq.delete(chatId) },
    forgetDeleted(isDeleted: (id: string) => boolean) {
      for (const id of new Set([...lastSeenSeq.keys(), ...optimistic.keys()])) {
        if (isDeleted(id)) { optimistic.delete(id); lastSeenSeq.delete(id) }
      }
    },
    retireProjected(chatIds: Iterable<string>) { for (const id of chatIds) optimistic.delete(id) },
    missingFrom: (merged: readonly ChatItem[]) => [...optimistic.values()].filter((r) => !merged.some((c) => c.id === r.id)),
  }
}

// 落地一份服务端列表并返回该进内存列表的那一份。#3661 不变量:本地保留 / 乐观补回的行不进 durable snapshot。
export async function applyFetchedChatList(
  ledger: ChatListProjectionLedger,
  repository: AccountImRepository,
  snapshot: { fetched: readonly ChatItem[]; identities: readonly unknown[] },
  into: { currentChats: readonly ChatItem[]; activeChatId: string | null; revokeMissingActive: boolean; isConversationDeleted?: (id: string) => boolean; liveChats?: () => readonly ChatItem[] },
): Promise<ChatItem[]> {
  const { identities } = snapshot
  const { currentChats, activeChatId, revokeMissingActive, isConversationDeleted } = into
  const fetched = snapshot.fetched.filter(chat => !isConversationDeleted?.(chat.id))
  if (isConversationDeleted) ledger.forgetDeleted(isConversationDeleted)
  const ids = new Set(fetched.map((chat) => chat.id))
  ledger.retireProjected(ids)
  if (revokeMissingActive && activeChatId) ledger.forgetChat(activeChatId)
  const merged = mergeFetchedChatsPreservingActiveLocal([...fetched], currentChats.filter(chat => !isConversationDeleted?.(chat.id)), activeChatId,
    { preserveMissingActive: !revokeMissingActive })
  // Select from the same live owner inside the repository transaction. A delayed
  // snapshot must not persist an optimistic tuple that was already rolled back.
  await publishChatSnapshot(repository, () => {
    const live = into.liveChats?.() ?? currentChats
    const published = shareRows(live, mergeFetchedChatsPreservingActiveLocal([...fetched], live, activeChatId,
      { preserveMissingActive: !revokeMissingActive }).filter(chat => ids.has(chat.id)))
    return published
  }, identities, isConversationDeleted)
  if (isConversationDeleted) ledger.forgetDeleted(isConversationDeleted)
  const visible = merged.filter(chat => !isConversationDeleted?.(chat.id))
  const missing = ledger.missingFrom(visible)
  // 结构共享:没变的会话行沿用内存里那一版对象。投影每批都重拼全部行,不共享的话一条新消息
  // 就让当前会话 activeChat 换身份,聊天面板里以它为依赖的派生全部重算、每条气泡的 memo 随之失效。
  return shareRows(currentChats, missing.length > 0 ? [...missing, ...visible] : visible)
}

/** Only the winner of the committed account message's IDB claim calls this outlet. */
export async function notifyForIngestedMessage(
  accountId: string,
  chat: ChatItem,
  message: MessageItem,
  context: { onScreen: (chatId: string) => boolean; notificationsEnabled: boolean; soundEnabled: boolean },
): Promise<void> {
  if (!platform.capabilities.notifications) return
  if (!shouldNotify({ kind: 'message', accountId, chat, message },
    { enabled: context.notificationsEnabled, onScreen: context.onScreen(chat.id) })) return
  await platform.showNotification({ ...createChatNotificationPayload({ ...chat,
    last_message_preview: chatPreviewText({ last_message_preview: message.content, last_message_failure: null }) }), silent: !context.soundEnabled })
}

/** 屏上正打开的主时间线不产生未读红点；手工标未读与别的话题流仍保留。 */
export function acknowledgeOnScreenChatRows(
  rows: readonly ChatItem[],
  context: {
    current?: readonly ChatItem[]
    onScreen: (chatId: string) => boolean
    canAcknowledge?: (chatId: string) => boolean
    /** 屏幕上真正可见的最大 seq(已落地的窗口消息);确认不得越过它。 */
    visibleSeqOf?: (chatId: string) => number
    patchChat: PatchChat
    /** 延迟写入真正执行时用它读**当前**的行:决策与执行之间隔着 await(评审)。 */
    liveRows?: () => readonly ChatItem[]
    deferPersist?: (persist: () => void) => void
  },
): ChatItem[] {
  const currentById = new Map(context.current?.map((chat) => [chat.id, chat]) ?? [])
  return rows.map((chat) => {
    if (!context.onScreen(chat.id) || context.canAcknowledge?.(chat.id) === false || chat.is_marked_unread) return chat
    const current = currentById.get(chat.id)
    // Leave manual intent to the authoritative merge, without preparing a competing read.
    if (current?.is_marked_unread) return chat
    // Choose the whole read tuple before raising its version. Combining an old count/locator
    // with a new optimistic version would defeat the merge's stale-response protection.
    const [basis] = mergeFetchedChatsPreservingActiveLocal([chat], current ? [current] : [], chat.id,
      { preserveMissingActive: false })
    if (basis.unread_count <= 0 || (basis.unread_locator && basis.unread_locator.stream_kind !== 'main')) return basis
    const visible = context.visibleSeqOf ? context.visibleSeqOf(chat.id) : Number.POSITIVE_INFINITY
    const seq = Math.min(Math.max(basis.last_read_seq, basis.next_message_seq - 1), visible)
    if (seq <= basis.last_read_seq) return basis
    const prepared = prepareProjectedReadWatermark(basis, seq, context.patchChat)
    const persist = () => {
      // 决策到这里中间隔着 await(评审):用户若刚标了手工未读,或读状态已往前走,这条确认作废 —— 本地不写,RPC 也不发。
      const latest = context.liveRows?.().find((row) => row.id === chat.id)
      if (latest?.is_marked_unread || (latest?.read_state_version ?? 0) > (basis.read_state_version ?? 0)) return
      prepared.persist()
    }
    if (context.deferPersist) context.deferPersist(persist)
    else persist()
    return prepared.chat
  })
}

// @@@chat-projection — store 这一侧怎么消费投影:属主按账号一个、权威行落地、接到 revision 派发上。
// 投影自己的代数与取数在 lib/chatProjection*.ts(唯一属主,spec I7);这里只有 store 那一半,
// 与上面 applyFetchedChatList 同域 —— 落地用的就是它。**快照与增量共用这一条**,❌ 不写第二套。
export function useChatProjectionBinding(deps: {
  ledger: ChatListProjectionLedger
  repositoryRef: MutableRefObject<AccountImRepository | null>
  getRepository: () => Promise<AccountImRepository>
  chatsRef: MutableRefObject<ChatItem[]>
  activeChatIdRef: MutableRefObject<string | null>
  requestSeqRef: MutableRefObject<number>
  notifications: { chatMessages: boolean; sound: boolean }
  canAcknowledge: (chatId: string) => boolean
  /** 屏幕上真正可见的最大 seq(已落地的窗口消息);确认不得越过它。 */
  visibleSeqOf: (chatId: string) => number
  setChats: (rows: ChatItem[]) => void
  /** 当前选中被权威地撤销了 —— store 自己决定怎么清空那一侧的状态。 */
  onActiveRevoked: (chatId: string) => void
}) {
  const { ledger, repositoryRef, getRepository, chatsRef, activeChatIdRef, requestSeqRef, setChats, onActiveRevoked, canAcknowledge, visibleSeqOf } = deps
  const ownerRef = useRef<{ accountId: string; owner: ChatProjection } | null>(null)
  // All list writers share chatsRef's owner; React is its subscribed view.
  // The ref must advance synchronously, including legitimate lower-version rollback.
  const acceptRows = useCallback((accountId: string, rows: ChatItem[]) => {
    if (repositoryRef.current?.accountId !== accountId) return
    setChats(rows)
    chatsRef.current = rows
  }, [repositoryRef, chatsRef, setChats])
  const patchChatFor = useCallback((accountId: string): PatchChat => (chatId, partial, expectedReadStateVersion) => {
    if (repositoryRef.current?.accountId !== accountId) return
    acceptRows(accountId, patchChatRows(chatsRef.current, chatId, partial, expectedReadStateVersion))
  }, [repositoryRef, acceptRows, chatsRef])

  const ownerFor = useCallback((accountId: string): ChatProjection => {
    if (ownerRef.current?.accountId !== accountId) {
      ownerRef.current?.owner.reset() // 换账号即换属主(store 不跨账号留存)
      ownerRef.current = { accountId, owner: createChatProjection(accountId, {
        rows: () => chatsRef.current,
        identity: (id) => repositoryRef.current?.accountId === accountId ? imSelectors.identitiesById(repositoryRef.current.snapshot())[id] : undefined,
      }) }
    }
    return ownerRef.current.owner
  }, [chatsRef, repositoryRef])

  /** `revokedMembership` 是增量那一路的另一半判据:要**权威的成员行 tombstone**,不是整表缺席(#4314)。 */
  const publish = useCallback(async (
    fetched: readonly ChatItem[],
    identities: readonly unknown[],
    options: { requestSeq: number; notify: boolean; preserveMissingActive?: boolean; revokedMembership?: (chatId: string) => boolean },
  ): Promise<void> => {
    const repository = await getRepository()
    const accountId = repository.accountId
    if (repositoryRef.current?.accountId !== accountId) return
    const activeChatId = activeChatIdRef.current
    const isConversationDeleted = ownerRef.current?.accountId === accountId
      ? ownerRef.current.owner.isConversationDeleted : undefined
    const revokeMissingActive = !!activeChatId && !!isConversationDeleted?.(activeChatId) || ledger.shouldRevokeActive({
      activeChatId, fetched, requestSeq: options.requestSeq, preserveMissingActive: options.preserveMissingActive,
    }) && (!options.revokedMembership || options.revokedMembership(activeChatId!))
    ledger.recordProjected(fetched, options.requestSeq)
    const published = await applyFetchedChatList(ledger, repository, { fetched, identities },
      { currentChats: chatsRef.current, activeChatId, revokeMissingActive, isConversationDeleted,
        liveChats: () => repositoryRef.current?.accountId === accountId ? chatsRef.current : [] })
    if (repositoryRef.current?.accountId !== accountId) return
    // Rejoin external updates delivered during the repository wait, including a
    // complete tuple accepted before React has committed either publication.
    const current = chatsRef.current
    // published may contain a local optimistic tuple copied before the await.
    // Rebase on the actual service rows and current owner, not that captured merge:
    // a legitimate rollback during the write must not become an old "server" row.
    const serviceById = new Map(fetched.map(row => [row.id, row]))
    const currentById = new Map(current.map(row => [row.id, row]))
    const rebased = published.flatMap(row => {
      const source = serviceById.get(row.id) ?? currentById.get(row.id)
      return source ? [source] : []
    })
    const merged = mergeFetchedChatsPreservingActiveLocal(rebased, current, activeChatIdRef.current,
      { preserveMissingActive: false })
    const pendingReads: Array<() => void> = []
    const acknowledged = acknowledgeOnScreenChatRows(merged, {
      current, onScreen: isChatOnScreen, canAcknowledge, visibleSeqOf, patchChat: patchChatFor(accountId),
      deferPersist: (persist) => pendingReads.push(persist),
    })
    acceptRows(accountId, shareRows(current, acknowledged))
    for (const persist of pendingReads) persist()
    if (revokeMissingActive && activeChatId) onActiveRevoked(activeChatId)
  }, [ledger, activeChatIdRef, canAcknowledge, visibleSeqOf, chatsRef, getRepository, onActiveRevoked, patchChatFor, acceptRows, repositoryRef])

  /** 冷启快照:一次「哪些会话属于我」的读 + 与增量同一套族读 ⇒ 2 波(spec I7,没有第二条拉取路)。 */
  const hydrate = useCallback((accountId: string) => ownerFor(accountId)
    .hydrate(readProjectionCursor(repositoryRef.current), currentAuthSessionSignal()), [ownerFor, repositoryRef])

  const hasDeletedConversation = useCallback((accountId: string, chats: readonly ChatItem[]) =>
    chats.some(chat => ownerFor(accountId).isConversationDeleted(chat.id)), [ownerFor])

  const identities = useCallback((accountId: string) => ownerFor(accountId).identities(), [ownerFor])

  const confirmPersonalDeletion = useCallback(async (accountId: string, receipt: PersonalConversationDeletion): Promise<boolean> => {
    const binding = ownerRef.current
    if (!binding || binding.accountId !== accountId) return false
    binding.owner.confirmPersonalDeletion(receipt) // Synchronous, before any older result can publish.
    ledger.forgetChat(receipt.chat_id)
    const repository = await getRepository()
    if (ownerRef.current !== binding || repository.accountId !== accountId) return false
    await repository.transaction(transaction => transaction.delete('chat', [accountId, receipt.chat_id]))
    return ownerRef.current === binding
  }, [getRepository, ledger])

  const attach = useCallback((accountId: string, subscribe: ChatProjectionAttachment['subscribe']) => {
    const owner = ownerFor(accountId)
    return owner.attach({
      subscribe,
      cursor: () => readProjectionCursor(repositoryRef.current),
      signal: currentAuthSessionSignal,
      publish: (rows) => publish(rows, owner.identities(), {
        requestSeq: ++requestSeqRef.current, notify: true,
        preserveMissingActive: false, revokedMembership: owner.isMembershipRevoked,
      }),
    })
  }, [ownerFor, publish, repositoryRef, requestSeqRef])

  // ⚠️ 必须**稳定**:返回新字面量 ⇒ 依赖它的 effect 与 useCallback 每渲染都重建 ⇒ 订阅/渲染循环
  // (实测:第一版返回字面量,chatSelectionIntent4314 直接跑到 heap OOM)。
  return useMemo(() => ({ hydrate, identities, publish, attach, hasDeletedConversation, confirmPersonalDeletion }), [hydrate, identities, publish, attach, hasDeletedConversation, confirmPersonalDeletion])
}
