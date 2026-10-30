import { messageItemFromRow, type RawMessageRow } from '../../cloud/messageItem'
import { parseAttachmentContent } from '../ui/attachmentModels'
import type { SearchDocument } from './types'

const LINK = /\bhttps?:\/\/\S/iu

/**
 * The one mapping from a read message row to an indexed document, through the existing message mapper.
 * null = nothing searchable (malformed, retracted, system, card/widget or empty): the row is not indexed.
 */
export function searchDocumentFromRow(raw: RawMessageRow, accountId: string): SearchDocument | null {
  const item = messageItemFromRow(raw, accountId)
  if (!item || item.seq < 1 || item.retracted_at) return null
  let text = ''
  let hasFile = false
  let hasImage = false
  if (item.content_type === 'text') text = item.content ?? ''
  else if (item.content_type === 'attachment') {
    const attachment = parseAttachmentContent(item.content, item)
    if (!attachment) return null
    text = [attachment.fileName, attachment.caption].filter(Boolean).join('\n')
    hasImage = attachment.kind === 'image'
    hasFile = !hasImage
  }
  if (!text.trim()) return null
  return {
    id: item.id,
    chatId: item.chat_id,
    threadRootId: item.thread_root_id ?? null,
    seq: item.seq,
    senderId: item.sender_user_id,
    createdAt: item.created_at,
    text,
    toUserIds: item.to_user_ids ?? [],
    isWhisper: item.is_whisper === true,
    hasFile,
    hasImage,
    hasLink: LINK.test(text),
  }
}
