import { dbPayload } from '@gugu/core/cloud/supabase'
import { parseAttachmentContent } from '@gugu/core/shared/ui/attachmentModels'
import type { MessageContentType } from '@gugu/core/shared/types/chat'
import { chatDb, getCurrentAuthUserId } from './supabase'
import { i18n } from '@/i18n'
import { CHAT_MEDIA_BUCKET } from './publicMedia'
import { setGroupAvatar } from '@gugu/core/cloud/groupAdmin'
import { currentGroupAdmin } from './groupAdmin'
import { dataClient } from './supabase'
import { forwardAttachment, shareAttachment } from '@gugu/core/cloud/attachmentsApi'
import { attachmentsEndpoint } from './attachmentsEndpoint'

/**
 * A file of a chat's folder forwarded as a file card (the folder's 「转发」): sent by reference (attachments/share), the bytes
 * stay where they are — a stored file at the version given, a text document as its text is now.
 */
export async function forwardFolderFile(file: { itemId: string; version: number; document: boolean }, targetChatId: string, senderId: string) {
  return shareAttachment(await attachmentsEndpoint(), {
    item_id: file.itemId, version: file.document ? null : file.version, message_id: crypto.randomUUID(), chat_id: targetChatId, sender_user_id: senderId,
  })
}

export async function forwardCanonicalMessage(
  sourceMessageId: string,
  targetChatId: string,
  senderId: string,
): Promise<{
  id: string
  chat_id: string
  content: string
  content_type: MessageContentType
  created_at: string
}> {
  const { data: source, error: sourceError } = await chatDb
    .from('messages')
    .select('id, chat_id, content, content_type, retracted_at, deleted_at, file_item_id, file_version, file_blob_id')
    .eq('id', sourceMessageId)
    .is('deleted_at', null)
    .maybeSingle()
  if (sourceError) throw new Error(sourceError.message)
  if (!source) throw new Error(`Source message not found: ${sourceMessageId}`)
  if ((source as { retracted_at: string | null }).retracted_at) {
    throw new Error(`Source message has been retracted: ${sourceMessageId}`)
  }
  const content = (source as { content: string | null }).content?.trim()
  if (!content) throw new Error(`Source message has no forwardable content: ${sourceMessageId}`)
  // 附件(#7290)一律由服务端转(attachments/forward):目标会话要有自己的条目、指向同一份字节;老式附件(字节在 chat-media)
  // 服务端把字节登记进新链再转,不再有指向 chat-media 的新消息;悄悄话的附件只有读得到原消息的人转得出去。
  // 照抄正文会发出一条没有指针的信封(对方看到「文件已删除」)。条目删了的(墓碑)不能转发。
  const fileRef = source as { id: string; content_type: string; file_item_id: string | null; file_version: number | null; file_blob_id: string | null }
  if (fileRef.content_type === 'attachment') {
    if (parseAttachmentContent(content, fileRef)?.source.kind === 'gone') {
      throw new Error(`Source attachment was deleted from its group folder: ${sourceMessageId}`)
    }
    const message = await forwardAttachment(await attachmentsEndpoint(), {
      source_message_id: sourceMessageId, message_id: crypto.randomUUID(), chat_id: targetChatId, sender_user_id: senderId,
    })
    return message as { id: string; chat_id: string; content: string; content_type: MessageContentType; created_at: string }
  }
  const insertedId = crypto.randomUUID()
  const { data: inserted, error: insertError } = await chatDb
    .from('messages')
    .insert(
      dbPayload({
        id: insertedId,
        chat_id: targetChatId,
        sender_user_id: senderId,
        content,
        content_type: (source as { content_type: MessageContentType }).content_type,
        forwarded_from_message_id: sourceMessageId,
        client_message_id: crypto.randomUUID(),
      }),
    )
    .select('id, chat_id, content, content_type, created_at')
    .single()
  if (insertError) throw new Error(insertError.message)
  return inserted as {
    id: string
    chat_id: string
    content: string
    content_type: MessageContentType
    created_at: string
  }
}

export async function uploadCanonicalGroupAvatar(chatId: string, file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error(i18n.t('group.settings.imageRequired', { ns: 'messaging' }))
  if (file.size > 5 * 1024 * 1024) throw new Error(i18n.t('group.settings.imageTooLarge', { ns: 'messaging' }))
  return setGroupAvatar(await currentGroupAdmin(), chatId, await getCurrentAuthUserId(), file, async (path, asset) => {
    const bucket = dataClient.storage.from(CHAT_MEDIA_BUCKET)
    const { error } = await bucket.upload(path, asset, { contentType: asset.type, upsert: false })
    if (error) throw new Error(error.message)
    return bucket.getPublicUrl(path).data.publicUrl
  })
}
