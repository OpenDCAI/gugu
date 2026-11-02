import { followLink, openLinkTarget } from './guguLinks'
import { chatService } from './chat'
import { getCurrentAuthUserId } from './supabase'
import { parseAttachmentContent } from '@gugu/core/shared/ui/attachmentModels'
import { notify } from './notices'
import { messageForUser } from './userFacingError'
import { parseSentAttachmentLink } from '@gugu/session-core/session-record/send-receipt'

/** Sent-file receipts can name a message before its folder-file pointer is in the local IM window. */
export function followConversationLink(href: string): boolean {
  const target = parseSentAttachmentLink(href)
  if (!target) return followLink(href)
  void openMessageAttachment(target.messageId, target.chatId).catch(error => notify({ tier: 'error', title: messageForUser(error) }))
  return true
}

export async function openMessageAttachment(messageId: string, chatId?: string): Promise<void> {
  const userId = await getCurrentAuthUserId()
  const message = userId ? await chatService.getMessageById(messageId, userId) : null
  const file = message && parseAttachmentContent(message.content, message)
  if (!message || !file || message.retracted_at || (chatId && message.chat_id !== chatId)) throw new Error('File reference is unavailable')
  if (file.kind === 'image') {
    const { openAttachmentImage } = await import('./attachmentBytes')
    openAttachmentImage(file.source, file.fileName)
  } else if (file.source.kind === 'item') {
    await openLinkTarget({ kind: 'file', itemId: file.source.itemId, version: file.source.version }, { message })
  } else {
    const { openAttachmentInSystemApp } = await import('./attachmentBytes')
    await openAttachmentInSystemApp(file.source, file.fileName)
  }
}
