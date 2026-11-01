import { getCurrentAuthUserId } from './supabase'
import { i18n } from '@/i18n'
import { CHAT_MEDIA_BUCKET } from './publicMedia'
import { setGroupAvatar } from '@gugu/core/cloud/groupAdmin'
import { currentGroupAdmin } from './groupAdmin'
import { dataClient } from './supabase'
import { shareAttachment } from '@gugu/core/cloud/attachmentsApi'
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
