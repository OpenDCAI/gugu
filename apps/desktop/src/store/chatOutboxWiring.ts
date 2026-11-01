import { openTopicTab } from '../session/renderer/features/chats/chat-tabs/chat-layouts'
import type { AppForwardFilesDetail } from '../session/shared/extensions/app-runtime-protocol'
import { commitAttachment, forwardAttachment, shareAttachment, type CommitArgs } from '@gugu/core/cloud/attachmentsApi'
import { messageItemFromRow } from '@gugu/core/cloud/messageItem'
import { attachmentsEndpoint, type PreparedChatAttachment } from '../lib/attachmentsEndpoint'
import { topicService, type CreateTopicInput, type CreatedTopic } from '../lib/topics'
// @@@send-outbox (#1762 洞③/#1941) — outbox 与 chat store 的接线层(卫星,参照 chatRealtimeMutations
// 的 mutators-bag 抽法):乐观行构造、状态迁移落 UI、送达连带动作(水位/预览/agent 运行态点亮)、
// 重启恢复注入、online kick。god-file chat.tsx 只保留「建乐观行 + enqueue」。
// 连带动作对「实时发送」与「重启恢复的投递」走同一条 onSent 路径——上下文一律从 refs/记录派生,
// 不闭包捕获发送时的组件状态(恢复投递没有那个闭包)。

import type { SetStateAction } from 'react'
import type { ToastType } from '../components/toastContext'
import type { ChatItem, MessageContentType, MessageItem } from '@gugu/core/shared/types/chat'
import { upsertMessageById } from '@gugu/core/shared/ui/messageListModels'
import { attachmentSendTiming, type AttachmentSendTiming } from '../lib/attachmentSendTiming'
import { settleAttachmentSend, type ObserveAttachmentMessage } from '../lib/attachmentSendRecovery'
import { chatService } from '../lib/chat'
import {
  ackOutboxRecord,
  deleteOutboxRecord,
  putOutboxRecord,
  readOutboxRecords,
  type AccountImRepository,
  type OutboxRecord,
  type OutboxOperation,
} from '../lib/imRepository'
import { advanceReadWatermark, applyThreadSnapshot } from './chatRealtimeMutations'
import { createChatOutbox, type ChatOutbox } from './chatOutbox'
import { i18n } from '@/i18n'
import { rendererLogger } from '@/lib/log'
import { chatSendTimings, finishChatSendTiming } from '../lib/chatSendTiming'

export interface OutboxWiringIo {
  observeMessage?: (senderId: string, chatId: string) => ObserveAttachmentMessage
  getImRepository(): Promise<AccountImRepository>
  user(): { id: string; nickname: string; avatarUrl: string | null } | null
  chats(): ChatItem[]
  identity(id: string): { type: 'human' | 'agent'; display_name: string; avatar: string | null } | undefined
  activeChatId(): string | null
  activeThreadRootId(chatId?: string): string | null
  setMessagesAndCache(updater: (prev: MessageItem[]) => MessageItem[], chatId: string): void
  setThreadMessages: (updater: SetStateAction<MessageItem[]>, chatId: string) => void
  patchChat(chatId: string, partial: Partial<ChatItem>): void
  toast(message: string, type?: ToastType): void
  /** @@@4439 — store 的权威单行摄入 chokepoint(store/chat.tsx appendMessage):按 id 归并主线窗口,
   *  并在权威 seq 越过窗口旧尾时异步重验证被跳过的区间(交错入站行不得沉到增量游标下方)。 */
  appendMessage(message: MessageItem): void
}

export interface OutboxWiring {
  outbox: ChatOutbox
  stageAttachment(message: MessageItem): Promise<void>
  commitAttachment(message: MessageItem, prepared: PreparedChatAttachment, commit: Omit<CommitArgs, 'staging_key'>, timing?: AttachmentSendTiming): Promise<void>
  forward(source: MessageItem | AppForwardFilesDetail['files'][number], targetChatId: string, senderUserId: string): Promise<void>
  createTopic(input: CreateTopicInput, senderUserId: string): Promise<CreatedTopic | null>
  dispose(): void
  /** sendMessage 入队入口:建持久化记录并入队(乐观行由 chat.tsx 先行插入,二者同 id)。 */
  enqueue(input: {
    submittedAt?: number
    id: string
    chatId: string
    senderUserId: string
    content: string
    toUserIds: string[] | null
    replyToMessageId: string | null
    threadRootId: string | null
    isThreadRoot: boolean
    isWhisper: boolean
    /** toUserIds 为 null 的私聊:对端在投递前解析(C2,乐观行不等这次往返)。 */
    resolveDmPeer?: boolean
    /** 投递前置(如 agent 私聊的会话页会话就绪)。只活在内存:重启恢复的投递没有它(C1)。 */
    beforeDeliver?: () => Promise<void>
  }): Promise<void>
  /** 启动恢复:重建乐观行注入主线缓存 + 开始投递;并挂 window online kick。返回清理函数。 */
  restoreAndWatch(): () => void
  /** 开话题时把该话题的未决行注入 threadMessages(applyThreadSnapshot 只保留已在场的乐观行)。 */
  injectThreadOutboxRows(chatId: string, rootId: string): void
  retrySend(clientMessageId: string): void
  discardSend(clientMessageId: string): void
}

// 乐观行从 outbox 记录重建(恢复路径)/首建(发送路径)共用一个构造,字段口径一处定。
export function outboxRecordToMessage(
  record: OutboxRecord,
  _user: { id: string; nickname: string; avatarUrl: string | null },
): MessageItem {
  return {
    ...record.preview,
    id: record.clientMessageId,
    chat_id: record.chatId,
    sender_user_id: record.senderUserId,
    to_user_ids: record.payload.toUserIds,
    is_whisper: record.payload.isWhisper,
    seq: -1,
    content: record.payload.content,
    content_type: record.payload.contentType as MessageContentType, // outbox 只收文本族(enqueue 恒 'text')
    reply_to_message_id: record.payload.replyToMessageId,
    thread_root_id: record.payload.threadRootId,
    is_thread_root: record.payload.isThreadRoot,
    retracted_at: null,
    created_at: record.enqueuedAt,
    reactions: [],
    is_mine: true,
    delivered: false,
    delivery_status: null,
    local_send_state: record.state === 'failed' ? 'failed' : 'sending',
    local_send_error: record.lastError,
    local_send_retryable: !record.dependencyDiscarded && record.operation?.kind !== 'upload',
    ...(record.operation?.kind === 'forward' && record.operation.source.kind === 'message' ? { forwarded_from_message_id: record.operation.source.id } : {}),
  }
}

/** The same durable shape backs text, attachment commits, forwards, and topic requests. */
export function outboxRecordForMessage(message: MessageItem, operation: OutboxOperation): OutboxRecord {
  if (!message.sender_user_id) throw new Error('An outbox operation requires a sender')
  const now = new Date().toISOString()
  return {
    clientMessageId: message.id, chatId: message.chat_id, senderUserId: message.sender_user_id,
    preview: { file_item_id: message.file_item_id, file_version: message.file_version, file_blob_id: message.file_blob_id,
      file_metadata: message.file_metadata, image_dimensions: message.image_dimensions },
    operation, dependsOn: operation.kind === 'forward' && operation.source.kind === 'message' ? operation.source.id : message.reply_to_message_id ?? undefined,
    payload: { content: message.content ?? '', contentType: message.content_type, toUserIds: message.to_user_ids ?? null,
      replyToMessageId: message.reply_to_message_id ?? null, threadRootId: message.thread_root_id ?? null,
      isThreadRoot: !!message.is_thread_root, isWhisper: !!message.is_whisper },
    state: 'pending', attempts: 0, lastError: null, enqueuedAt: now, updatedAt: now,
  }
}

// C2 投递前置:私聊对端在投递时解析(不再挡在乐观行之前)。解析不到 = fail loud,不发 null-target 哑消息(#1554)。
export async function resolveOutboxRecipients(
  record: OutboxRecord,
  getDmPeerUserId: (chatId: string, userId: string) => Promise<string | null>,
): Promise<OutboxRecord> {
  if (record.payload.toUserIds !== null || !record.payload.resolveDmPeer) return record
  const peer = await getDmPeerUserId(record.chatId, record.senderUserId)
  if (!peer) throw new Error(i18n.t('outbox.recipientMissing', { ns: 'messaging', chatId: record.chatId }))
  return { ...record, payload: { ...record.payload, toUserIds: [peer], resolveDmPeer: false } }
}

export function createOutboxWiring(io: OutboxWiringIo): OutboxWiring {
  let active = true
  // Bytes never enter persistence. An interrupted native publication requires a fresh selection.
  const attachmentTimings = new Map<string, AttachmentSendTiming>()
  const nativeCommits = new Map<string, () => Promise<MessageItem>>()
  const topicResults = new Map<string, CreatedTopic | undefined>()
  // clientMessageId → 本次会话里发送方交来的投递前置。送达/丢弃即删;失败保留,手动重试会再跑一次。
  const beforeDeliverHooks = new Map<string, () => Promise<void>>()
  // 状态迁移 → 乐观行 local_send_state(pending/sending 统一显示「发送中」,failed 显示「未送达」)。
  function reflectState(record: OutboxRecord): void {
    if (!active) return
    const state = record.state === 'failed' ? 'failed' : 'sending'
    const patchRow = (m: MessageItem) =>
      m.id === record.clientMessageId ? { ...m, local_send_state: state as MessageItem['local_send_state'], local_send_error: record.lastError, local_send_retryable: !record.dependencyDiscarded && record.operation?.kind !== 'upload' } : m
    if (record.payload.threadRootId) {
      io.setThreadMessages((prev) => prev.map(patchRow), record.chatId)
    } else {
      io.setMessagesAndCache((prev) => prev.map(patchRow), record.chatId)
    }
    // fail-loud 不许失踪(#1762 评审[9]):终态 failed 时那条乐观行若不在屏上(话题已关/切了会话),
    // 「未送达」badge 无处渲染 → 用全局 toast 外化;行仍在 outbox,回到现场即可重试/丢弃。
    if (record.state === 'failed') {
      if (record.operation?.kind === 'attachment') attachmentTimings.get(record.clientMessageId)?.finish('failed', 'outbox')
      finishChatSendTiming(record.clientMessageId)
      rendererLogger('chat/outbox').error({ chatId: record.chatId, messageId: record.clientMessageId, error: record.lastError }, 'message send failed')
      const onScreen = record.payload.threadRootId
        ? io.activeChatId() === record.chatId && io.activeThreadRootId() === record.payload.threadRootId
        : io.activeChatId() === record.chatId
      if (!onScreen) io.toast(i18n.t('outbox.offscreenFailure', { ns: 'messaging' }), 'error')
    }
  }

  function removeRow(record: OutboxRecord): void {
    beforeDeliverHooks.delete(record.clientMessageId)
    nativeCommits.delete(record.clientMessageId)
    attachmentTimings.delete(record.clientMessageId)
    if (!active) return
    if (record.payload.threadRootId) {
      io.setThreadMessages((prev) => prev.filter((m) => m.id !== record.clientMessageId), record.chatId)
    } else {
      io.setMessagesAndCache((prev) => prev.filter((m) => m.id !== record.clientMessageId), record.chatId)
    }
  }

  // 送达连带动作(实时发送与恢复投递同路径;上下文全部从 refs/record 派生):
  // 主线:权威 row 替换乐观行 + 自读水位推进;话题:重拉话题 + 摘要刷新;共通:侧栏预览。
  // ❌ 这里不点亮 agent 运行态:「我发出去了」不是「它在跑」的证据(那是猜,而且猜早了 400ms);
  // 运行态只由跑这个 agent 的宿主宣布,见 spec agent-status。
  async function handleSent(record: OutboxRecord, persisted: MessageItem): Promise<void> {
    beforeDeliverHooks.delete(record.clientMessageId)
    nativeCommits.delete(record.clientMessageId)
    attachmentTimings.get(record.clientMessageId)?.finish('success', 'outbox')
    attachmentTimings.delete(record.clientMessageId)
    if (!active) return
    const user = io.user()
    if (!user) return
    const { chatId } = record
    const threadRootId = record.payload.threadRootId
    if (threadRootId) {
      const [msgs] = await Promise.all([
        chatService.getThreadMessages(chatId, threadRootId, user.id),
      ])
      if (!active) return
      applyThreadSnapshot({ chatId, rootId: threadRootId, msgs, chats: io.chats(),
        setThreadMessages: (update) => io.setThreadMessages(update, chatId), patchChat: io.patchChat,
        activeChatId: () => chatId, activeThreadRootId: () => io.activeThreadRootId(chatId) })
    } else {
      // @@@4439 ack-seq-jump — 权威 row 经 store 的单行摄入 chokepoint 落窗:appendMessage 在合并时
      // 检测权威 seq 是否越过窗口旧尾,越过即异步重验证被跳过的区间(交错落库的入站行不得沉到增量
      // 游标下方——那会让 realtime/下一次发送/reload 三路取数永久漏掉它)。重验证不阻塞本函数:
      // #1884 的水位推进与侧栏预览都不依赖它。
      io.appendMessage(persisted)
      // #1884 自己刚发的消息自己已读——立即推水位,不等 realtime 回显的 markRead 竞态。
      advanceReadWatermark(io.chats(), chatId, persisted.seq, io.patchChat)
    }
    io.patchChat(chatId, {
      last_message_preview: record.payload.content.slice(0, 100),
      last_message_failure: null,
      last_message_at: new Date().toISOString(),
    })
  }

  const outbox = createChatOutbox({
    load: async () => {
      if (!active) return []
      const repository = await io.getImRepository()
      return active ? readOutboxRecords(repository) : []
    },
    save: async (record) => {
      if (!active) throw new Error('outbox scope disposed before durable enqueue')
      const repository = await io.getImRepository()
      if (!active) throw new Error('outbox scope disposed before durable enqueue')
      await putOutboxRecord(repository, record)
    },
    remove: async (clientMessageId) => {
      if (!active) return
      const repository = await io.getImRepository()
      if (active) await deleteOutboxRecord(repository, clientMessageId)
    },
    ack: async (record, delivered, isActive) => {
      if (!active || !isActive()) throw new Error('outbox scope disposed before durable ack')
      const repository = await io.getImRepository()
      if (!active || !isActive()) throw new Error('outbox scope disposed before durable ack')
      if (record.operation?.kind === 'topic') {
        await deleteOutboxRecord(repository, record.clientMessageId)
        if (topicResults.has(record.clientMessageId)) topicResults.set(record.clientMessageId, delivered as CreatedTopic)
        return delivered
      }
      const persisted = delivered as MessageItem
      if (!active || !isActive()) throw new Error('outbox scope disposed before durable ack')
      await ackOutboxRecord(repository, record.clientMessageId, persisted)
      return persisted
    },
    prepare: async (record) => {
      await beforeDeliverHooks.get(record.clientMessageId)?.()
      return resolveOutboxRecipients(record, (chatId, userId) => chatService.getDmPeerUserId(chatId, userId))
    },
    deliver: async (record) => {
      const operation = record.operation
      if (operation?.kind === 'topic') return topicService.createTopic(operation.input)
      if (operation?.kind === 'upload') throw new Error(i18n.t('outbox.selectFileAgain', { ns: 'messaging' }))
      let raw: Record<string, unknown> | undefined
      if (operation?.kind === 'attachment') {
        const timing = attachmentTimings.get(record.clientMessageId) ?? attachmentSendTiming(record.clientMessageId, record.chatId)
        raw = await timing.stage('commit', record.attempts + 1, async () => commitAttachment(await attachmentsEndpoint(), operation.commit))
      }
      if (operation?.kind === 'nativeAttachment') {
        const publish = nativeCommits.get(record.clientMessageId)
        if (publish) {
          // Publish native bytes at most once. A lost IPC acknowledgement is
          // reconciled by the same message id on a later attempt.
          nativeCommits.delete(record.clientMessageId)
          const result = await publish()
          return result
        } else {
          const timing = attachmentTimings.get(record.clientMessageId) ?? attachmentSendTiming(record.clientMessageId, record.chatId)
          const existing = await timing.stage('readback', record.attempts + 1, () => chatService.getMessageById(record.clientMessageId, record.senderUserId))
          if (existing) return existing
          throw new Error(i18n.t('outbox.selectFileAgain', { ns: 'messaging' }))
        }
      }
      if (operation?.kind === 'forward' && operation.source.kind === 'file') {
        raw = await shareAttachment(await attachmentsEndpoint(), {
          item_id: operation.source.id, version: operation.source.version, message_id: record.clientMessageId,
          chat_id: record.chatId, sender_user_id: record.senderUserId,
        })
      }
      if (operation?.kind === 'forward' && operation.source.kind === 'message' && record.payload.contentType === 'attachment') {
        raw = await forwardAttachment(await attachmentsEndpoint(), {
          source_message_id: operation.source.id, message_id: record.clientMessageId,
          chat_id: record.chatId, sender_user_id: record.senderUserId, to_user_ids: record.payload.toUserIds ?? [],
        })
      }
      if (raw) {
        const message = messageItemFromRow(raw, record.senderUserId)
        if (!message || message.id !== record.clientMessageId || message.chat_id !== record.chatId || message.sender_user_id !== record.senderUserId || message.seq <= 0) throw new Error('Attachment commit returned an invalid message')
        return message
      }
      return chatService.sendMessage(record.chatId, record.senderUserId, record.payload.content,
        record.clientMessageId, record.payload.contentType, {
          toUserIds: record.payload.toUserIds, replyToMessageId: record.payload.replyToMessageId,
          threadRootId: record.payload.threadRootId, isThreadRoot: record.payload.isThreadRoot, isWhisper: record.payload.isWhisper,
          ...(operation?.kind === 'forward' && operation.source.kind === 'message' ? { forwardedFromMessageId: operation.source.id } : {}),
        })
    },
    onState: reflectState,
    onSent: (record, acknowledged) => {
      if (record.operation?.kind === 'topic') {
        const topic = acknowledged as CreatedTopic
        openTopicTab(record.chatId, { topicChatId: topic.chat_id, name: topic.name })
        removeRow(record)
        return
      }
      return handleSent(record, acknowledged as MessageItem).catch((err) => {
        // 连带动作失败(回读/摘要刷新)不影响送达事实——realtime 回显会补;大声记录不静默。
        console.error('[chatOutbox] post-send side effects failed', err)
      })
    },
    onDiscarded: removeRow,
  })

  return {
    outbox,
    async stageAttachment(message) {
      await outbox.stageUpload(outboxRecordForMessage(message, { kind: 'upload' }))
    },
    async commitAttachment(message, prepared, commit, timing = attachmentSendTiming(message.id, message.chat_id)) {
      attachmentTimings.set(message.id, timing)
      const operation: OutboxOperation = 'staging_key' in prepared
        ? { kind: 'attachment', commit: { ...commit, staging_key: prepared.staging_key } }
        : { kind: 'nativeAttachment', commit }
      if ('local' in prepared) nativeCommits.set(message.id, async () => {
        const row = await settleAttachmentSend({ endpoint: await attachmentsEndpoint(), prepared, commit, timing,
          observeMessage: io.observeMessage?.(commit.sender_user_id, message.chat_id),
          onLateMessage: row => { if (active) void outbox.confirm(message.id, row) },
        })
        if (!row) throw new Error(i18n.t('outbox.sendFailed', { ns: 'messaging' }))
        return row
      })
      if (!await outbox.commitUpload(outboxRecordForMessage(message, operation))) nativeCommits.delete(message.id)
    },
    async forward(source, targetChatId, senderUserId) {
      const file = 'itemId' in source
      const message: MessageItem = { ...(file ? { content: source.name, content_type: 'system' as const } : source),
        id: crypto.randomUUID(), chat_id: targetChatId, sender_user_id: senderUserId,
        to_user_ids: null, is_whisper: false, thread_root_id: null, reply_to_message_id: null, is_thread_root: false,
        seq: -1, created_at: new Date().toISOString(), reactions: [], is_mine: true, local_send_state: 'sending',
        retracted_at: null, delivered: false, delivery_status: null }
      const record = outboxRecordForMessage(message, { kind: 'forward', source: file
        ? { kind: 'file', id: source.itemId, version: source.document ? null : source.version }
        : { kind: 'message', id: source.id } })
      const target = io.chats().find(chat => chat.id === targetChatId)
      record.payload.resolveDmPeer = target?.kind === 'dm' || target?.kind === 'ai'
      await outbox.enqueue(record)
      io.appendMessage(outboxRecordToMessage(record, io.user()!))
    },
    async createTopic(input, senderUserId) {
      const id = crypto.randomUUID()
      const record = outboxRecordForMessage({ id, chat_id: input.sourceChatId, sender_user_id: senderUserId,
        content: input.name || i18n.t('history.createTopic', { ns: 'messaging' }), content_type: 'system' } as MessageItem,
        { kind: 'topic', input: { ...input, topicId: id } })
      record.dependsOn = input.sourceMessageId
      topicResults.set(id, undefined)
      try {
        await outbox.enqueue(record)
        io.appendMessage(outboxRecordToMessage(record, io.user()!))
        try { await outbox.delivered(id) } catch { return null } // durable failure is actionable in the existing row
        const created = topicResults.get(id)
        if (!created) throw new Error('Topic creation was not acknowledged')
        return created
      } finally { topicResults.delete(id) }
    },
    dispose() {
      active = false
      beforeDeliverHooks.clear()
      nativeCommits.clear()
      attachmentTimings.clear()
      topicResults.clear()
      outbox.dispose()
    },
    async enqueue(input) {
      const nowIso = new Date().toISOString()
      const record: OutboxRecord = {
        clientMessageId: input.id,
        chatId: input.chatId,
        senderUserId: input.senderUserId,
        payload: {
          content: input.content,
          contentType: 'text',
          toUserIds: input.toUserIds,
          replyToMessageId: input.replyToMessageId,
          threadRootId: input.threadRootId,
          isThreadRoot: input.isThreadRoot,
          isWhisper: input.isWhisper,
          ...(input.resolveDmPeer ? { resolveDmPeer: true } : {}),
        },
        dependsOn: input.replyToMessageId ?? undefined,
        state: 'pending',
        attempts: 0,
        lastError: null,
        enqueuedAt: nowIso,
        updatedAt: nowIso,
      }
      if (input.beforeDeliver) beforeDeliverHooks.set(record.clientMessageId, input.beforeDeliver)
      chatSendTimings.set(input.id, { submit: input.submittedAt ?? performance.now() })
      try {
        await outbox.enqueue(record)
        if (!active) chatSendTimings.delete(input.id)
      } catch (err) {
        finishChatSendTiming(input.id)
        // enqueue 拒绝 ⇒ outbox 无归属:撤掉 chat.tsx 先行插入的同 id 乐观行(否则留下永远「发送中」
        // 的幽灵气泡),失败意图的唯一归属是 composer 草稿(InputArea 的回滚恢复)。
        if (active) removeRow(record)
        throw err
      }
    },
    restoreAndWatch() {
      if (!active) return () => {}
      void outbox.restore().then((records) => {
        if (!active) return
        const user = io.user()
        if (!user) return
        for (const record of records) {
          if (record.payload.threadRootId) continue // 话题行在 openThread 时经 injectThreadOutboxRows 注入
          const row = outboxRecordToMessage(record, user)
          io.setMessagesAndCache((prev) => upsertMessageById(prev, row), record.chatId)
        }
      }).catch((err) => { if (active) console.error('[chatOutbox] restore failed', err) })
      // 网络恢复 → 全部 failed 自动重投(验收②的自动路径;拍板 a:退避封顶后交 online kick)
      const onOnline = () => { if (active) void outbox.retryAllFailed() }
      window.addEventListener('online', onOnline)
      return () => window.removeEventListener('online', onOnline)
    },
    injectThreadOutboxRows(chatId, rootId) {
      const user = io.user()
      if (!user) return
      const rows = outbox.pendingFor(chatId, rootId).map((r) => outboxRecordToMessage(r, user))
      if (rows.length === 0) return
      io.setThreadMessages((prev) => rows.reduce((list, row) => upsertMessageById(list, row), prev), chatId)
    },
    retrySend(clientMessageId) {
      if (active) void outbox.retry(clientMessageId).catch((err) => { if (active) console.error('[chatOutbox] retry failed', err) })
    },
    discardSend(clientMessageId) {
      if (active) void outbox.discard(clientMessageId).catch((err) => { if (active) console.error('[chatOutbox] discard failed', err) })
    },
  }
}
