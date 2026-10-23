import { useCallback, useMemo, useRef, type MutableRefObject } from 'react'
import { mergeFetchedChatsPreservingActiveLocal } from '@gugu/core/shared/ui/chatModels'
import { createChatNotificationPayload, shouldNotifyForChat } from '@gugu/core/shared/ui/chatNotificationModels'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { publishChatSnapshot } from '../lib/chatSnapshotPublication'
import { replaceEqualDeep } from '@tanstack/react-query'
import { platform } from '../platform'
import { chatOnScreen } from '../lib/onScreenChat'
import { rendererLogger } from '../lib/log'
import { chatPreviewText } from '../lib/agentTurnFailure'
import type { AccountImRepository } from '../lib/imRepository'
import { currentAuthSessionSignal } from '../lib/authSessionLoss'
import {
  createChatProjection, readProjectionCursor,
  type ChatProjection, type ChatProjectionAttachment,
} from '../lib/chatProjection'

// @@@selection-is-intent (#4314) — 一次刷新没提到某条会话，含义取决于这一发相对「最后一次看见它」有多新：
// 刚 open_dm 出来的会话还没被任何一发投影过，对它的沉默是仪器还没读到、不是阴性读数。契约见 [[conversation-data]]。
export type ChatListProjectionLedger = ReturnType<typeof createChatListProjectionLedger>

const chatListLog = rendererLogger('chat/list-projection')

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
    retireProjected(chatIds: Iterable<string>) { for (const id of chatIds) optimistic.delete(id) },
    missingFrom: (merged: readonly ChatItem[]) => [...optimistic.values()].filter((r) => !merged.some((c) => c.id === r.id)),
  }
}

// 落地一份服务端列表并返回该进内存列表的那一份。#3661 不变量:本地保留 / 乐观补回的行不进 durable snapshot。
export async function applyFetchedChatList(
  ledger: ChatListProjectionLedger,
  repository: AccountImRepository,
  snapshot: { fetched: readonly ChatItem[]; identities: readonly unknown[] },
  into: { currentChats: readonly ChatItem[]; activeChatId: string | null; revokeMissingActive: boolean },
): Promise<ChatItem[]> {
  const { fetched, identities } = snapshot
  const { currentChats, activeChatId, revokeMissingActive } = into
  const ids = new Set(fetched.map((chat) => chat.id))
  ledger.retireProjected(ids)
  if (revokeMissingActive && activeChatId) ledger.forgetChat(activeChatId)
  const merged = mergeFetchedChatsPreservingActiveLocal([...fetched], [...currentChats], activeChatId,
    { preserveMissingActive: !revokeMissingActive })
  await publishChatSnapshot(repository, merged.filter((chat) => ids.has(chat.id)), identities)
  const missing = ledger.missingFrom(merged)
  // 结构共享:没变的会话行沿用内存里那一版对象。投影每批都重拼全部行,不共享的话一条新消息
  // 就让当前会话 activeChat 换身份,聊天面板里以它为依赖的派生全部重算、每条气泡的 memo 随之失效。
  return replaceEqualDeep(currentChats as ChatItem[], missing.length > 0 ? [...missing, ...merged] : merged)
}

/** 刷新带回的新消息通知扇出：与列表状态机无关的纯副作用（#1757 逐域抽取）。 */
export function notifyForRefreshedChats(
  previous: readonly ChatItem[],
  fetched: readonly ChatItem[],
  context: { activeChatId: string | null; notificationsEnabled: boolean; soundEnabled: boolean },
): void {
  if (!platform.capabilities.notifications) return
  const previousById = new Map(previous.map((chat) => [chat.id, chat]))
  for (const chat of fetched) {
    if (!shouldNotifyForChat(previousById.get(chat.id), chat, context)) continue
    void platform.showNotification({ ...createChatNotificationPayload({ ...chat, last_message_preview: chatPreviewText(chat) }), silent: !context.soundEnabled })
      .catch((err) => chatListLog.error({ reason: String(err) }, 'show notification failed'))
  }
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
  setChats: (rows: ChatItem[]) => void
  /** 当前选中被权威地撤销了 —— store 自己决定怎么清空那一侧的状态。 */
  onActiveRevoked: (chatId: string) => void
}) {
  const { ledger, repositoryRef, getRepository, chatsRef, activeChatIdRef, requestSeqRef, setChats, onActiveRevoked } = deps
  const { chatMessages: notifyMessages, sound: notifySound } = deps.notifications
  const ownerRef = useRef<{ accountId: string; owner: ChatProjection } | null>(null)

  const ownerFor = useCallback((accountId: string): ChatProjection => {
    if (ownerRef.current?.accountId !== accountId) {
      ownerRef.current?.owner.reset() // 换账号即换属主(store 不跨账号留存)
      ownerRef.current = { accountId, owner: createChatProjection(accountId) }
    }
    return ownerRef.current.owner
  }, [])

  /** `revokedMembership` 是增量那一路的另一半判据:要**权威的成员行 tombstone**,不是整表缺席(#4314)。 */
  const publish = useCallback(async (
    fetched: readonly ChatItem[],
    identities: readonly unknown[],
    options: { requestSeq: number; notify: boolean; preserveMissingActive?: boolean; revokedMembership?: (chatId: string) => boolean },
  ): Promise<void> => {
    const activeChatId = activeChatIdRef.current
    const revokeMissingActive = ledger.shouldRevokeActive({
      activeChatId, fetched, requestSeq: options.requestSeq, preserveMissingActive: options.preserveMissingActive,
    }) && (!options.revokedMembership || options.revokedMembership(activeChatId!))
    ledger.recordProjected(fetched, options.requestSeq)
    if (options.notify) {
      notifyForRefreshedChats(chatsRef.current, fetched,
        { activeChatId: chatOnScreen(), notificationsEnabled: notifyMessages, soundEnabled: notifySound })
    }
    setChats(await applyFetchedChatList(ledger, await getRepository(), { fetched, identities },
      { currentChats: chatsRef.current, activeChatId, revokeMissingActive }))
    if (revokeMissingActive && activeChatId) onActiveRevoked(activeChatId)
  }, [ledger, activeChatIdRef, chatsRef, getRepository, notifyMessages, notifySound, onActiveRevoked, setChats])

  /** 冷启快照:一次「哪些会话属于我」的读 + 与增量同一套族读 ⇒ 2 波(spec I7,没有第二条拉取路)。 */
  const hydrate = useCallback((accountId: string) => ownerFor(accountId)
    .hydrate(readProjectionCursor(repositoryRef.current), currentAuthSessionSignal()), [ownerFor, repositoryRef])

  const identities = useCallback((accountId: string) => ownerFor(accountId).identities(), [ownerFor])

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
  return useMemo(() => ({ hydrate, identities, publish, attach }), [hydrate, identities, publish, attach])
}
