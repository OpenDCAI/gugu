import { chatDb } from './supabase'

export type MemberReadState = {
  lastReadSeq: number
  isMarkedUnread: boolean
  version: number
}

/** 手动标未读。已读不走这里,走 readWriter.writeRead。 */
export async function markMemberUnread(chatId: string): Promise<MemberReadState> {
  const { data, error } = await chatDb.rpc('mark_unread', { p_chat_id: chatId })
  if (error) throw new Error(error.message)
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null
  if (!row) throw new Error('mark_unread returned no member read state')
  const lastReadSeq = Number(row.last_read_seq)
  const version = Number(row.version)
  if (!Number.isFinite(lastReadSeq) || !Number.isInteger(version) || typeof row.is_marked_unread !== 'boolean') {
    throw new Error('mark_unread returned malformed member read state')
  }
  return { lastReadSeq, isMarkedUnread: row.is_marked_unread, version }
}
