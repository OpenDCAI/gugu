import type { MessageItem } from './types/chat'

export type ReplySource = Pick<MessageItem, 'sender_user_id' | 'to_user_ids' | 'is_whisper'>

/** Private replies keep the original pair unless explicitly published; null means that pair is unavailable. */
export function resolveReplyDelivery(input: {
  senderUserId?: string | null
  source?: ReplySource | null
  toUserIds?: readonly string[] | null
  whisper?: boolean
}): { toUserIds: string[]; isWhisper: boolean } | null {
  const { source, senderUserId } = input
  if (source?.is_whisper && input.whisper !== false) {
    const recipients = source.to_user_ids ?? []
    if (!senderUserId || !source.sender_user_id || recipients.length !== 1
      || ![source.sender_user_id, ...recipients].includes(senderUserId)) {
      return null
    }
    const peer = source.sender_user_id === senderUserId ? recipients[0] : source.sender_user_id
    if (!peer || peer === senderUserId) return null
    return { toUserIds: [peer], isWhisper: true }
  }
  return { toUserIds: [...(input.toUserIds ?? [])], isWhisper: input.whisper === true }
}
