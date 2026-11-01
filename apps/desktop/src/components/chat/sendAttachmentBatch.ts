import type { OutboxWiring } from '../../store/chatOutboxWiring'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { formatAttachmentMetadata, inferAttachmentKind, resolveFileMimeType } from '@gugu/core/shared/ui/attachmentModels'
import { type AttachmentsEndpoint } from '@gugu/core/cloud/attachmentsApi'
import { attachmentsEndpoint, prepareChatAttachment, type PreparedChatAttachment } from '../../lib/attachmentsEndpoint'
import { requireThreadCapableChat } from '../../lib/chatThreadGate'
import { attachmentSendTiming, attachmentUploadTimeoutMs, type AttachmentSendTiming } from '../../lib/attachmentSendTiming'
import { attachmentAttemptEndpoint, retryAttachmentUpload } from '../../lib/attachmentSendRecovery'
import { setAttachmentUploadProgress } from '../../lib/attachmentUploadProgress'

// Bytes upload concurrently outside the lane. The existing outbox owns each source id
// from selection through commit, including failure and restart visibility.
const UPLOAD_CONCURRENCY = 3

function startBoundedUploads(files: File[], endpoint: AttachmentsEndpoint, scope: { chat_id: string; as: string; is_whisper?: boolean }, timings: AttachmentSendTiming[]): Promise<PreparedChatAttachment>[] {
  const settle: Array<{ resolve: (value: PreparedChatAttachment) => void; reject: (error: unknown) => void }> = []
  const results = files.map(() => new Promise<PreparedChatAttachment>((resolve, reject) => { settle.push({ resolve, reject }) }))
  // 未被 await 到的失败(中止点之后的件)不应成为 unhandledrejection。
  for (const result of results) result.catch(() => undefined)
  let next = 0
  const worker = async () => {
    while (next < files.length) {
      const index = next
      next += 1
      try {
        const file = files[index]
        const prepared = await retryAttachmentUpload(attempt => timings[index].stage('upload', attempt,
          (signal, capDeadline, progress) => {
            setAttachmentUploadProgress(timings[index].clientId)
            return prepareChatAttachment(attachmentAttemptEndpoint(endpoint, signal), file,
            { ...scope, request_id: timings[index].clientId }, plan => { capDeadline(plan.expires_at); progress() }, attempt > 1,
            transfer => { progress(transfer.loaded, transfer.total); setAttachmentUploadProgress(timings[index].clientId, { ...transfer, attempt }) })
          },
          undefined, { timeoutMs: attachmentUploadTimeoutMs(file.size) }))
        settle[index].resolve(prepared)
      } catch (error) {
        timings[index].finish('failed', 'upload')
        settle[index].reject(error)
      } finally {
        setAttachmentUploadProgress(timings[index].clientId)
      }
    }
  }
  for (let lane = 0; lane < Math.min(UPLOAD_CONCURRENCY, files.length); lane += 1) void worker()
  return results
}

async function placeholderRow(file: File, caption: string | undefined, args: { chatId: string; senderId: string; toUserIds: string[] | null; isWhisper?: boolean; replyToMessageId?: string | null; threadRootId?: string | null; isThreadRoot?: boolean }) {
  let dimensions: MessageItem['image_dimensions']
  if (inferAttachmentKind(file) === 'image') {
    try {
      const image = await createImageBitmap(file)
      try { dimensions = { width: image.width, height: image.height } } finally { image.close() }
    } catch { /* A local decoder need not support every uploadable image format. */ }
  }
  const previewUrl = URL.createObjectURL(file)
  const message: MessageItem = {
    id: crypto.randomUUID(),
    chat_id: args.chatId,
    sender_user_id: args.senderId,
    to_user_ids: args.toUserIds,
    is_whisper: !!args.isWhisper,
    seq: -1,
    content: formatAttachmentMetadata({
      kind: inferAttachmentKind(file),
      fileName: file.name || 'file',
      mimeType: resolveFileMimeType(file),
      url: previewUrl,
      sizeBytes: file.size,
      caption,
    }),
    content_type: 'attachment',
    reply_to_message_id: args.replyToMessageId ?? null,
    thread_root_id: args.threadRootId ?? null,
    is_thread_root: !!args.isThreadRoot,
    retracted_at: null,
    created_at: new Date().toISOString(),
    reactions: [],
    is_mine: true,
    delivered: false,
    delivery_status: null,
    local_send_state: 'sending',
    ...(dimensions ? { image_dimensions: dimensions } : {}),
  }
  // 预览 URL 等确认行换上真地址之后再释放(下一帧,避免那一帧的 <img> 指向已撤销的 blob)。
  const release = () => { setTimeout(() => URL.revokeObjectURL(previewUrl), 1000) }
  return { message, release }
}

export async function sendAttachmentBatch(args: {
  files: File[]
  chatId: string
  senderId: string
  toUserIds: string[] | null
  isWhisper?: boolean
  replyToMessageId?: string | null
  threadRootId?: string | null
  isThreadRoot?: boolean
  onSent?: (file: File, index: number) => void
  caption?: string
  outbox: Pick<OutboxWiring, 'stageAttachment' | 'commitAttachment'> & { outbox: Pick<OutboxWiring['outbox'], 'delivered' | 'failUpload' | 'discard'> }
  appendMessage: (message: MessageItem) => void
}): Promise<string | undefined> {
  if (!args.files.length) return undefined
  if (args.threadRootId != null || args.isThreadRoot === true) await requireThreadCapableChat(args.chatId, 'sendAttachmentBatch')
  const captionIndex = args.files.findLastIndex(file => inferAttachmentKind(file) === 'image')
  const placeholders: Awaited<ReturnType<typeof placeholderRow>>[] = []
  let index = 0
  try {
    for (const [fileIndex, file] of args.files.entries()) {
      const row = await placeholderRow(file, fileIndex === captionIndex ? args.caption : undefined, args)
      placeholders.push(row)
      // Durable ownership precedes visibility; uploading does not block the lane.
      await args.outbox.stageAttachment(row.message)
      args.appendMessage(row.message)
      void args.outbox.outbox.delivered(row.message.id).then(row.release, () => {})
    }
    const timings = placeholders.map(row => attachmentSendTiming(row.message.id, args.chatId))
    const uploads = startBoundedUploads(args.files, await attachmentsEndpoint(), {
      chat_id: args.chatId, as: args.senderId, is_whisper: args.isWhisper,
    }, timings)
    for (; index < args.files.length; index++) {
      const file = args.files[index], row = placeholders[index]
      const prepared = await uploads[index]
      await args.outbox.commitAttachment(row.message, prepared, {
        message_id: row.message.id, chat_id: args.chatId, sender_user_id: args.senderId,
        file_name: file.name || 'file', content_type: resolveFileMimeType(file), to_user_ids: args.toUserIds ?? [],
        reply_to_message_id: args.replyToMessageId ?? null, thread_root_id: args.threadRootId ?? null,
        is_thread_root: !!args.isThreadRoot, is_whisper: !!args.isWhisper,
        ...(index === captionIndex && args.caption ? { caption: args.caption } : {}),
      }, timings[index])
      // Only ready commits belong to outbox retry now. Uncommitted File objects
      // still belong to the composer and return there on this round's failure.
      args.onSent?.(file, index)
    }
  } catch (error) {
    // Also handles a partially staged batch: never leave an upload marker with
    // no upload task. Source-dependent forwards fail through ordinary discard.
    for (const row of placeholders.slice(index)) {
      await args.outbox.outbox.discard(row.message.id)
      row.release()
    }
    throw error
  }
  return placeholders[0]?.message.id
}
