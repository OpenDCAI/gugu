// @@@5649 账号 revision 事件 → 打开着的会话线的直接应用。原则:事件自己带着事实,客户端只应用、不回读。
// 与 accountRevisionCoordinator / accountRevisionRuntime 同属 revision 总线这一层(❌ 不算进 #3271 要收缩的旧 IM 产品面),
// 线的持有者只做接线。每个监听器都有一条「载荷不足以单独落地」的退路,退路一律是旧的整读路径,❌ 不猜。
//
// @@@6470 「线」= 屏幕上正在显示的一条会话时间线:主区的 activeChat 是一条(store),右侧话题分栏是另一条
// (话题是一条真的 chat)。线级修订 —— 新消息、删除、表情、送达/已读回执、成员已读水位、成员进出 —— **只在这里**
// 接一次:每条线交出同一个 ChatLine 端口,subscribeChatLineRevisions 按 line.chatId() 过滤并落地。
// 此前话题分栏手抄了一份只有两类事件的订阅,漏了 delivery_changed,于是在话题里 @ agent,它读了你也看不到
// (#6470);端口字段全部必填,哪条线少接一个 sink 就编译不过,再加一类线级事件也只改这一处。
import type { Dispatch, SetStateAction } from 'react'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { messageItemFromRow, type RawMessageRow } from '@gugu/core/cloud/messageItem'
import { advanceMemberReadSeq, agentReaderUserId, applyDeliveryReceipt } from '@gugu/core/shared/ui/messageState'
import { chatService } from './chat'
import {
  readDeliveryRevision,
  readMemberReadRevision,
  readMemberRosterRevision,
  readMessageCreatedRevision,
  readRevisionResourceKey,
  type AccountRevisionEvent,
  type AccountRevisionListener,
} from './accountRevisionCoordinator'
import {
  applyMessageDeletedEvent,
  applyReactionChangedEvent,
  reconcileMemberReadSeqs,
  type RealtimeMessageMutators,
} from '../store/chatRealtimeMutations'

/** 一条线的「对端读到哪了」水位表(per-OTHER-member last_read_seq)。容器见 hooks/useMemberReadSeqs。 */
export type MemberReadSeqsStore = {
  /** 表现在属于哪条 chat(#1529:同会话单调 merge,换会话整体替换)。 */
  memberReadSeqsChatRef: { current: string | null }
  setMemberReadSeqs: Dispatch<SetStateAction<Record<string, number>>>
  /** 事件时刻读表的真值 —— 成员进出要问「这个人在不在分母里」,❌ 不能等下一次渲染。 */
  readMemberReadSeqs: () => Record<string, number>
}

export type ChatLine = RealtimeMessageMutators & MemberReadSeqsStore & {
  userId: string
  /** 这条线此刻显示哪条 chat(null = 没开)。事件时刻读,所以换线不必重挂订阅。 */
  chatId: () => string | null
  maxSeqOf: (chatId: string) => number
  getMessageSnapshotEpoch: (chatId: string) => number
  /** readSeqs 为 null = 载荷里没有水位信息,别动成员已读表(空表会被当成「没有其他成员」把圆环全抹掉)。 */
  applyMessagesSnapshot: (chatId: string, msgs: MessageItem[], readSeqs: Record<string, number> | null, epoch: number) => void
  /** 增量不足以落地时的整读补洞。throwOnError 时失败要抛,让修订派发退避重试(R6)。 */
  healMessageGap: (chatId: string, throwOnError: boolean) => Promise<void>
  /** 窗口里已有行的覆盖层(表情/送达/读者)与删改的有界重验证。 */
  revalidateWindowOverlays: (chatId: string, throwOnError: boolean) => Promise<void>
}

type SubscribeAccountRevision = (event: AccountRevisionEvent, listener: AccountRevisionListener) => () => void

export function subscribeChatLineRevisions(subscribe: SubscribeAccountRevision, line: ChatLine): () => void {
  const onLine = (
    event: AccountRevisionEvent,
    apply: (keys: readonly { chatId: string; entityId: string | null }[]) => void | Promise<void>,
  ) => subscribe(event, async (operations) => {
    const keys = operations.map((operation) => readRevisionResourceKey(operation.payload, event)).filter((key) => key.chatId === line.chatId())
    if (keys.length > 0) await apply(keys)
  })
  const unsubscribes = [
    subscribe('message_created', applyMessageCreatedRevisions(line)),
    onLine('message_deleted', (keys) => {
      for (const { chatId, entityId } of keys) {
        if (!entityId) throw new Error('message_deleted revision requires entity_id')
        applyMessageDeletedEvent(entityId, chatId, line)
      }
    }),
    onLine('reaction_changed', async (keys) => {
      const unique = new Map(keys.map(({ chatId, entityId }) => {
        if (!entityId) throw new Error('reaction_changed revision requires entity_id')
        return [`${chatId}:${entityId}`, { chatId, entityId }] as const
      }))
      await Promise.all([...unique.values()].map(({ chatId, entityId }) => applyReactionChangedEvent({ messageId: entityId, reactorUserId: '' }, line.userId, chatId, line)))
    }),
    subscribe('delivery_changed', applyDeliveryRevisions(line)),
    // @@@5649 已读水位直接来自事件载荷,不再回读 chat_members。
    subscribe('member_read_changed', applyMemberReadRevisions(line)),
    subscribe('chat_members_changed', applyMemberRosterRevisions(line)),
  ]
  return () => { for (const unsubscribe of unsubscribes) unsubscribe() }
}

// @@@5649 已读回执直接吃 revision 事件里的水位(单调推进,#1529 口径),省掉那次 ~400 ms 的 chat_members 回读;
// 只有迁移前落库、没带 last_read_seq 的旧行才回读一次。只处理这条线上的会话;自己的读行跳过。
function applyMemberReadRevisions(line: ChatLine): AccountRevisionListener {
  return async (operations) => {
    const chatId = line.chatId()
    if (!chatId) return
    let needsFetch = false
    for (const operation of operations) {
      const read = readMemberReadRevision(operation.payload)
      if (read.chatId !== chatId || read.userId === line.userId) continue
      // 事件是**一个成员**的增量,❌ 不能当全量快照喂 reconcile(快照语义会把没提到的成员从分母里删掉,
      // 群里一条已读事件就让其他成员的圆环全部消失);水位表还不属于这条会话时,退回全量回读。
      if (read.lastReadSeq === null || line.memberReadSeqsChatRef.current !== chatId) { needsFetch = true; continue }
      const { userId, lastReadSeq } = read
      line.setMemberReadSeqs((prev) => advanceMemberReadSeq(prev, userId, lastReadSeq))
    }
    if (!needsFetch) return
    const readSeqs = await chatService.getOtherMembersReadSeqs(chatId, line.userId)
    if (line.chatId() === chatId) reconcileMemberReadSeqs(chatId, readSeqs, line)
  }
}

// @@@6470 成员进出 → 已读分母。chat_members 行的**任何**写都会发这条(含每一次读水位 UPDATE),所以只认两种:
// 退出(tombstone)⇒ 从分母里摘掉;表里还没有的人(新加入 —— 话题里「被 @ 就是被拉进来」)⇒ 回读一次快照
// (快照对成员集合有权威,水位单调 merge)。已在表里的人的行更新 ❌ 不回读:读水位已由 member_read_changed 带值。
// 不接这条的后果:在话题里 @ 一个还没参与的 agent,它不在分母里 ⇒ 定向消息的收件方 = to_user_ids ∩ 表 = 空 ⇒
// 它读了也不出环,要重开才有(#6470)。
function applyMemberRosterRevisions(line: ChatLine): AccountRevisionListener {
  return async (operations) => {
    const chatId = line.chatId()
    if (!chatId) return
    let needsFetch = false
    for (const operation of operations) {
      const { chatId: rosterChatId, memberId, left } = readMemberRosterRevision(operation.payload)
      if (rosterChatId !== chatId || memberId === line.userId) continue
      if (!memberId || line.memberReadSeqsChatRef.current !== chatId) { needsFetch = true; continue }
      if (left) line.setMemberReadSeqs((prev) => withoutMember(prev, memberId))
      else if (!(memberId in line.readMemberReadSeqs())) needsFetch = true
    }
    if (!needsFetch) return
    const readSeqs = await chatService.getOtherMembersReadSeqs(chatId, line.userId)
    if (line.chatId() === chatId) reconcileMemberReadSeqs(chatId, readSeqs, line)
  }
}

function withoutMember(prev: Record<string, number>, memberId: string): Record<string, number> {
  if (!(memberId in prev)) return prev
  const next = { ...prev }
  delete next[memberId]
  return next
}

// @@@5649 agent 的送达/已读回执直接打到消息行上(delivered 置位、本人 agent 的 delivery_status 单调升、read 的 agent
// 进 readers 并集),不再为一条回执重拉整个窗口的覆盖层;旧行没带 receipt 才重验证一次。只处理这条线上的会话。
function applyDeliveryRevisions(line: ChatLine): AccountRevisionListener {
  return async (operations) => {
    const chatId = line.chatId()
    if (!chatId) return
    let needsRevalidate = false
    for (const operation of operations) {
      const delivery = readDeliveryRevision(operation.payload)
      if (delivery.chatId !== chatId) continue
      if (!delivery.receipt) { needsRevalidate = true; continue }
      const { deviceId, status } = delivery.receipt
      const reader = status === 'read' ? agentReaderUserId(deviceId) : null
      line.setMessagesAndCache((prev) => prev.map((message) => {
        if (message.id !== delivery.messageId) return message
        const next = applyDeliveryReceipt(message, { status, device_id: deviceId }, line.userId)
        if (reader && !(next.readers ?? []).includes(reader)) next.readers = [...(next.readers ?? []), reader]
        return next
      }), chatId)
    }
    if (needsRevalidate) await line.revalidateWindowOverlays(chatId, true)
  }
}

// @@@5649 新消息直接从事件载荷进窗口:sync_since 已把 message_created 的消息行(messages_view 同形)带回,这条线
// 把它追加到窗口即可,❌ 不再为一条新消息跑「断线补洞」(4 路并行读 + 覆盖层重验证,dev 中继下 3 s)。
// 仍走补洞的几种情况,每种都是「载荷不足以单独落地」:迁移前旧行 / 行已删(含对我删除)/ 话题回复与话题根(主线之外
// 还要连话题快照与摘要一起补,#1588)/ 窗口已验证尾与来行之间有缺口(交错入站,#4439 同源)。
type ArrivedMessageRow = RawMessageRow & { deleted_at?: unknown; deleted_for_user_ids?: unknown; is_imported_history_root?: unknown }
function applyMessageCreatedRevisions(line: ChatLine): AccountRevisionListener {
  return async (operations) => {
    const chatId = line.chatId()
    if (!chatId) return
    const arrivals = operations.map((operation) => readMessageCreatedRevision(operation.payload)).filter((arrival) => arrival.chatId === chatId)
    if (arrivals.length === 0) return
    const epoch = line.getMessageSnapshotEpoch(chatId)
    const items: MessageItem[] = []
    for (const { message } of arrivals) {
      const row = message as ArrivedMessageRow | null
      const deletedForMe = Array.isArray(row?.deleted_for_user_ids) && row.deleted_for_user_ids.includes(line.userId)
      const standalone = row && !row.deleted_at && !deletedForMe && !row.thread_root_id && row.is_thread_root !== true && row.is_imported_history_root !== true
      const item = standalone ? messageItemFromRow(row, line.userId) : null
      if (!item || item.seq < 1) return line.healMessageGap(chatId, true)
      items.push(item)
    }
    items.sort((a, b) => a.seq - b.seq)
    const verifiedTail = line.maxSeqOf(chatId)
    if (verifiedTail > 0 && items[0]!.seq > verifiedTail + 1) return line.healMessageGap(chatId, true)
    line.applyMessagesSnapshot(chatId, items, null, epoch)
  }
}
