import { followLink, openLinkTarget } from './guguLinks'
import { chatService } from './chat'
import { getCurrentAuthUserId } from './supabase'
import { parseAttachmentContent } from '@gugu/core/shared/ui/attachmentModels'
import { notify } from './notices'
import { messageForUser } from './userFacingError'

/** Sent-file receipts can name a message before its folder-file pointer is in the local IM window. */
export function followConversationLink(href: string): boolean {
  const match = /^gugu-message-file:\/\/([a-f0-9-]{36})$/i.exec(href)
  if (!match) return followLink(href)
  void openMessageAttachment(match[1]).catch(error => notify({ tier: 'error', title: messageForUser(error) }))
  return true
}

export async function openMessageAttachment(messageId: string): Promise<void> {
  const userId = await getCurrentAuthUserId()
  const message = userId ? await chatService.getMessageById(messageId, userId) : null
  const file = message && parseAttachmentContent(message.content, message)
  if (!message || !file || message.retracted_at) throw new Error('File reference is unavailable')
  if (file.source.kind === 'item') {
    await openLinkTarget({ kind: 'file', itemId: file.source.itemId, version: file.source.version }, { message })
  } else {
    const { openAttachmentInSystemApp } = await import('./attachmentBytes')
    await openAttachmentInSystemApp(file.source, file.fileName)
  }
}
