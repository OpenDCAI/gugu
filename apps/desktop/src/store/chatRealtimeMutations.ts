import type { Dispatch, SetStateAction } from 'react'
import type { ChatItem, MessageItem } from '@gugu/core/shared/types/chat'
import { chatService } from '../lib/chat'
import { mergeMemberReadSeqs } from '@gugu/core/shared/ui/messageState'
import { i18n } from '@/i18n'

// @@@realtime-single-msg-mutations — 从 store/chat.tsx 抽出的「实时事件只改动单条消息」处理：全局删除
// (#1729) 与表情回应变更 (#1873)。二者都对「当前打开会话窗口 + 话题视图 + L2」按 message_id 就地改一条，
// 逻辑同形，放一处便于共享 mutator 契约、也让 god-file chat.tsx 不再随这类事件继续膨胀。
export type RealtimeMessageMutators = {
  // updater 只走函数式（实时改动都基于前值），chatId 显式（可能是非活动会话缓存，见 setMessagesAndCache 注释）。
  setMessagesAndCache: (updater: (prev: MessageItem[]) => MessageItem[], chatId: string) => void
  persistWindowToLocalSync: (chatId: string, messages: MessageItem[]) => void
  setThreadMessages: Dispatch<SetStateAction<MessageItem[]>>
}

// #1729 — 全局删除实时到达：对齐发起端 deleteMessage 的本地处理（窗口 filter + L2 同步，防 IndexedDB 冷启
// 复活）。thread 回复的删除同样清 threadMessages。列表行预览由 recompute_chat_last_message + chats
// `chat_changed` revision 独立刷新列表，此处只处理消息窗口。
export function applyMessageDeletedEvent(
  messageId: string,
  activeChatId: string,
  m: RealtimeMessageMutators,
): void {
  m.setMessagesAndCache((prev) => {
    const next = prev.filter((msg) => msg.id !== messageId)
    if (next.length !== prev.length) m.persistWindowToLocalSync(activeChatId, next)
    return next
  }, activeChatId)
  m.setThreadMessages((prev) => prev.filter((msg) => msg.id !== messageId))
}

// #1873 — 对端加/取消表情回应的实时到达。回应是聚合 overlay（按 emoji 分组的 count + my_reaction），直接套
// 增量易在「自己回显 + 广播回显」双算 / 多设备下漂移，故重取该条权威 overlay 覆盖 reactions 字段（idempotent；
// my_reaction 由 RLS 按当前用户算准）。只覆盖 reactions，delivery/read 字段各有自己的实时通道、不动。message_id
// 全局唯一且仅存在于其所属会话缓存 → 按 id patch 无跨会话 bleed。
//
// reactorUserId === 当前用户时跳过（对齐 member_read_changed 的 userId 自跳过）：本端 toggleReaction 乐观路径
// 已走权威 getMessages 刷新，若再自刷一次既多余，又可能与乐观刷新竞态——「加后即撤」时旧 add 事件的重取若落在
// 撤销之后写回，会复活刚撤销的回应。
//
// 已知小缺口（自愈）：两个不同用户在极短时间内对同一条消息各加回应时，两次独立的 overlay 重取的 HTTP 响应若
// 乱序到达，后写的可能是较早的快照 → 少显一个回应，直到下次重开会话 revalidateWindow 校正。
export async function applyReactionChangedEvent(
  event: { messageId: string; reactorUserId: string },
  userId: string,
  activeChatId: string,
  m: RealtimeMessageMutators,
): Promise<void> {
  if (event.reactorUserId === userId) return
  const reactedId = event.messageId
  const overlays = await chatService.fetchMessageOverlays([reactedId], userId)
  const overlay = overlays.get(reactedId)
  if (!overlay) return
  m.setMessagesAndCache((prev) => {
    let changed = false
    const next = prev.map((msg) => {
      if (msg.id !== reactedId) return msg
      changed = true
      return { ...msg, reactions: overlay.reactions }
    })
    // @@@msg-cache (#621) - write-through 让 L2 持有最新回应（对齐 message_created 的写穿），冷启不必等重开
    // revalidate 才补上；未命中窗口则不动缓存。
    if (changed) m.persistWindowToLocalSync(activeChatId, next)
    return changed ? next : prev
  }, activeChatId)
  // 话题回复上的回应同样活更新（thread 视图不走 L2 持久化，内存 patch 即可）。
  m.setThreadMessages((prev) =>
    prev.map((msg) => (msg.id === reactedId ? { ...msg, reactions: overlay.reactions } : msg)),
  )
}

// @@@1888 — 「可见 ⇒ 已读」的唯一 chokepoint。此前水位推进散在 chat.tsx 的 5 个手工点（快照提交/
// realtime 主线/realtime 话题/openThread/sendMessage 两分支），每个 early-return 分支都要自己记得推
// ——#1886(话题)、whisper 分支全是「忘了的分支」。收口后:任何让消息上屏的代码路径一律调本函数族,
// 未守卫的 markChatReadUpTo 收为模块私有,新代码从此**没有**绕过守卫的出口。
//
// 守卫语义（对齐服务端 mark_read 的单调性,同时保护本地乐观 patch）：
//   seq <  known → 整个跳过:陈旧 seq(如开旧话题)绝不回拍本地水位、不发无谓 RPC——否则别处真有
//                  未读时 badge 假清零、下次 refetch 复活(#1886 的症状形态);
//   seq == known → 普通状态只补本地 patch；若存在手工未读标记，仍发 RPC 原子清除它；
//   seq >  known → 服务端 markRead + 本地 patch(原 markChatReadUpTo 语义)。
// extraPatch 供主线 realtime 到达顺带刷侧栏预览/时间(whisper 勿传:服务端预览就不含 whisper)。
export type PatchChat = (
  chatId: string,
  partial: Partial<ChatItem>,
  expectedReadStateVersion?: number,
) => void

export function patchChatRows(
  chats: ChatItem[],
  chatId: string,
  partial: Partial<ChatItem>,
  expectedReadStateVersion?: number,
): ChatItem[] {
  return chats.map((chat) => {
    if (chat.id !== chatId) return chat
    if (expectedReadStateVersion !== undefined && (chat.read_state_version ?? 0) !== expectedReadStateVersion) return chat
    return { ...chat, ...partial }
  })
}

export async function persistManualUnread(
  chats: ChatItem[],
  chatId: string,
  patchChat: PatchChat,
  showError: (message: string, type: 'error') => void,
): Promise<void> {
  try {
    const state = await chatService.markUnread(chatId)
    const unreadCount = chats.find((chat) => chat.id === chatId)?.unread_count ?? 0
    patchChat(chatId, {
      last_read_seq: state.lastReadSeq,
      is_marked_unread: state.isMarkedUnread,
      read_state_version: state.version,
      unread_count: Math.max(unreadCount, 1),
    })
  } catch (error) {
    console.error('[ChatStore] markUnread failed', error)
    showError(i18n.t('chatList.markUnreadFailed', { ns: 'messaging' }), 'error')
  }
}

export function advanceReadWatermark(
  chats: ChatItem[],
  chatId: string,
  seq: number,
  patchChat: PatchChat,
  extraPatch?: Partial<ChatItem>,
): void {
  if (seq < 0) return
  const current = chats.find((c) => c.id === chatId)
  const known = current?.last_read_seq ?? 0
  if (seq < known) return
  const shouldPersist = seq > known || current?.is_marked_unread === true
  const previousReadState = {
    unread_count: current?.unread_count ?? 0,
    // 读失败回滚连定位一起还:话题算进项目行的是定位里的 addressed_count,只还 unread_count 会少算。
    unread_locator: current?.unread_locator ?? null,
    last_read_seq: known,
    is_marked_unread: current?.is_marked_unread ?? false,
    read_state_version: current?.read_state_version ?? 0,
  }
  const optimisticVersion = previousReadState.read_state_version + (shouldPersist ? 1 : 0)
  if (shouldPersist) {
    markChatReadUpTo(chatId, seq, patchChat, optimisticVersion, previousReadState)
  }
  patchChat(chatId, {
    // A thread can remain unread while the main stream advances. The next
    // authoritative list refresh owns the aggregate; do not erase a locator
    // for another stream optimistically.
    ...(!current?.unread_locator || current.unread_locator.stream_kind === 'main' ? { unread_locator: null, unread_count: 0 } : {}),
    last_read_seq: seq,
    is_marked_unread: false,
    read_state_version: optimisticVersion,
    ...extraPatch,
  })
}

// @@@1884 服务端水位推进（chat.mark_read,服务端单调只增）。模块私有:守卫在 advanceReadWatermark,
// 这里只管发 RPC——导出即给新代码留绕过守卫的后门(#1888 收口的全部意义就在堵死它)。
function markChatReadUpTo(
  chatId: string,
  seq: number,
  patchChat: PatchChat,
  optimisticVersion: number,
  previousReadState: Pick<ChatItem, 'unread_count' | 'unread_locator' | 'last_read_seq' | 'is_marked_unread' | 'read_state_version'>,
): void {
  chatService.markRead(chatId, seq).catch((err) => {
    console.error('[ChatStore] markRead failed', err)
    patchChat(chatId, previousReadState, optimisticVersion)
  })
}

// @@@1888 — healMessageGap 的话题伙伴(卫星:god-file chat.tsx 冻结)。拆成 fetch/apply 两半,
// 让 heal 能「先并行拉、主线落地后再落话题」:
// - fetchOpenThreadSnapshot:fail-soft(无打开话题/拉取失败 → null)——话题重拉失败绝不阻断 heal
//   其余步骤(overlays/readSeqs 的 always-run 不变量,与 revalidateWindowOverlays 自身的 fail-soft 同约)。
// - applyThreadSnapshot:整窗替换但**保留乐观行**(seq<0 的在途发送,契约同 revalidateWindowOverlays
//   的 "Optimistic rows are NEVER dropped"——否则 heal 竞态会吞掉发送失败态/重试 affordance);
//   竞态守卫同 openThread(仅当仍停留在同会话同话题);水位经 #1904 chokepoint ToLatest 推进。
export async function fetchOpenThreadSnapshot(io: {
  chatId: string
  userId: string
  activeThreadRootId: () => string | null
}): Promise<{ rootId: string; msgs: MessageItem[] } | null> {
  const rootId = io.activeThreadRootId()
  if (!rootId) return null
  try {
    return { rootId, msgs: await chatService.getThreadMessages(io.chatId, rootId, io.userId) }
  } catch (err) {
    console.error('[ChatStore] fetchOpenThreadSnapshot failed', err)
    return null
  }
}

export function applyThreadSnapshot(input: {
  chatId: string
  rootId: string
  msgs: MessageItem[]
  chats: ChatItem[]
  activeChatId: () => string | null
  activeThreadRootId: () => string | null
  setThreadMessages: Dispatch<SetStateAction<MessageItem[]>>
  patchChat: (chatId: string, partial: Partial<ChatItem>) => void
}): void {
  if (input.activeChatId() !== input.chatId || input.activeThreadRootId() !== input.rootId) return
  input.setThreadMessages((prev) => {
    const optimistic = prev.filter((m) => m.seq < 0 && !input.msgs.some((s) => s.id === m.id))
    return optimistic.length ? [...input.msgs, ...optimistic] : input.msgs
  })
  // Thread reads use the stream-scoped owner. The legacy chat-level watermark must not
  // clear a mainline badge just because a thread has a higher global chat seq.
}

// #1529 — 对端读位的单调 reconcile(唯一实现,applyMessagesSnapshot 与无增量 heal 共用):同会话
// merge(在途旧快照不得把 realtime 已推进的水位回退成未读),换会话整体替换。
export function reconcileMemberReadSeqs(
  chatId: string,
  readSeqs: Record<string, number>,
  io: {
    memberReadSeqsChatRef: { current: string | null }
    setMemberReadSeqs: Dispatch<SetStateAction<Record<string, number>>>
  },
): void {
  const sameChat = io.memberReadSeqsChatRef.current === chatId
  io.memberReadSeqsChatRef.current = chatId
  io.setMemberReadSeqs((prev) => (sameChat ? mergeMemberReadSeqs(prev, readSeqs) : readSeqs))
}
