import { chatService } from '../../lib/chat'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { formatAttachmentMetadata, inferAttachmentKind, resolveFileMimeType } from '@gugu/core/shared/ui/attachmentModels'
import { type AttachmentsEndpoint } from '@gugu/core/cloud/attachmentsApi'
import { attachmentsEndpoint, prepareChatAttachment, commitPreparedChatAttachment, type PreparedChatAttachment } from '../../lib/attachmentsEndpoint'
import { requireThreadCapableChat } from '../../lib/chatThreadGate'
import { i18n } from '@/i18n'

// @@@2188 composer 分阶段发送的附件批执行器(自 ChatAreaPanel.handleSendAttachments 抽出)。
// #7290 gugu-3:字节经 attachments/upload 直传 OSS,attachments/commit 把它放进会话的「附件」、发一条附件消息(说明由服务端接在
// 信封后面)。并发 upload、逐件按序 commit → 读回验证;验证通过并 appendMessage 后才算「本件已提交」,经 onSent 按件回报,
// composer 的失败回滚据此只恢复未提交残余。任一件失败即 throw、中止后续。没提交的上传不用清:暂存一小时没人用就过期回收。
const UPLOAD_CONCURRENCY = 3

function startBoundedUploads(files: File[], endpoint: AttachmentsEndpoint, scope: { chat_id: string; as: string; is_whisper?: boolean }): Promise<PreparedChatAttachment>[] {
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
        settle[index].resolve(await prepareChatAttachment(endpoint, file, scope))
      } catch (error) {
        settle[index].reject(error)
      }
    }
  }
  for (let lane = 0; lane < Math.min(UPLOAD_CONCURRENCY, files.length); lane += 1) void worker()
  return results
}

function placeholderRow(file: File, caption: string | undefined, args: { chatId: string; senderId: string; toUserIds: string[] | null; isWhisper?: boolean }) {
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
    reply_to_message_id: null,
    thread_root_id: null,
    is_thread_root: false,
    retracted_at: null,
    created_at: new Date().toISOString(),
    reactions: [],
    is_mine: true,
    delivered: false,
    delivery_status: null,
    local_send_state: 'sending',
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
  threadRootId?: string | null
  isThreadRoot?: boolean
  onSent?: (file: File, index: number) => void
  caption?: string
  appendMessage: (message: MessageItem) => void
  /** 上传中的占位气泡要撤掉时(中止点及之后的件)调用;不给则不画占位。 */
  removePlaceholder?: (messageId: string) => void
}): Promise<string | undefined> {
  let firstInsertedId: string | undefined
  // 说明文字挂在最后一张**图**上:挂在末尾的 PDF 上时文件卡片不画说明,人就看不见这句话。
  const captionIndex = args.files.findLastIndex((file) => inferAttachmentKind(file) === 'image')
  // 点下发送的那一刻每件先上屏一个「发送中」占位(本地预览),确认行用同一个 id 原位替换它;
  // 否则多张图要等上传+插入+读回全走完才冒出来,中间什么都看不到。话题回复不画(它不进主时间线)。
  const placeholders = args.removePlaceholder && !args.threadRootId
    ? args.files.map((file, i) => placeholderRow(file, i === captionIndex ? args.caption : undefined, args))
    : null
  for (const row of placeholders ?? []) args.appendMessage(row.message)
  let index = 0
  try {
    // 私聊不支持话题(同 chatService.sendMessage 的闸,服务端不另核):在传任何字节之前拒。
    if (args.threadRootId != null || args.isThreadRoot === true) await requireThreadCapableChat(args.chatId, 'sendAttachmentBatch')
    // 上传并发(限 UPLOAD_CONCURRENCY 路)、提交仍按原顺序逐件:多张图不再一张等一张传完,顺序也不乱。
    const endpoint = await attachmentsEndpoint()
    const uploads = startBoundedUploads(args.files, endpoint, { chat_id: args.chatId, as: args.senderId, is_whisper: args.isWhisper })
    for (; index < args.files.length; index += 1) {
      const file = args.files[index]
      const prepared = await uploads[index]
      const inserted = await commitPreparedChatAttachment(endpoint, prepared, {
        message_id: placeholders?.[index].message.id ?? crypto.randomUUID(),
        chat_id: args.chatId,
        sender_user_id: args.senderId,
        file_name: file.name || 'file',
        content_type: resolveFileMimeType(file),
        to_user_ids: args.toUserIds ?? [],
        thread_root_id: args.threadRootId ?? null,
        is_thread_root: !!args.isThreadRoot,
        is_whisper: !!args.isWhisper,
        ...(index === captionIndex && args.caption ? { caption: args.caption } : {}),
      })
      const persisted = await chatService.getMessageById(String(inserted.id), args.senderId)
      if (persisted) {
        // appendMessage 按 thread_root_id 自路由：话题附件进 threadMessages,主线附件进主时间线。
        args.appendMessage(persisted)
        placeholders?.[index].release()
        firstInsertedId ??= persisted.id
        args.onSent?.(file, index)
      } else {
        throw new Error(i18n.t('composer.attachmentPersistenceFailed', { ns: 'messaging', fileName: file.name }))
      }
    }
  } catch (error) {
    // @@@attachment-send-surface (#841) - do NOT swallow: rethrow so InputArea rolls back the
    // optimistic clear and toasts the real reason (e.g. "mime type not supported", quota, RLS).
    console.error('[sendAttachmentBatch] Failed to send attachment:', args.files[index]?.name, error)
    // 中止点及之后的占位撤掉:这些件回到输入框草稿里,不能同时留一个永远「发送中」的气泡。
    for (const row of placeholders?.slice(index) ?? []) {
      args.removePlaceholder?.(row.message.id)
      row.release()
    }
    throw error
  }
  return firstInsertedId
}
