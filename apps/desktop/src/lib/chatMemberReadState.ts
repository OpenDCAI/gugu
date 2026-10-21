import { chatDb } from './supabase'

export type MemberReadState = {
  lastReadSeq: number
  isMarkedUnread: boolean
  version: number
}

export type StreamReadState = {
  streamId: string
  lastReadSeq: number
  isMarkedUnread: boolean
  version: number
}

function fromRpc(data: unknown, operation: 'mark_read' | 'mark_unread'): MemberReadState {
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null
  if (!row) throw new Error(`${operation} returned no member read state`)
  const lastReadSeq = Number(row.last_read_seq)
  const version = Number(row.version)
  if (!Number.isFinite(lastReadSeq) || !Number.isInteger(version) || typeof row.is_marked_unread !== 'boolean') {
    throw new Error(`${operation} returned malformed member read state`)
  }
  return { lastReadSeq, isMarkedUnread: row.is_marked_unread, version }
}

export async function markMemberRead(chatId: string, seq: number): Promise<MemberReadState> {
  const { data, error } = await chatDb.rpc('mark_read', { p_chat_id: chatId, p_seq: seq })
  if (error) throw new Error(error.message)
  return fromRpc(data, 'mark_read')
}

export async function markMemberUnread(chatId: string): Promise<MemberReadState> {
  const { data, error } = await chatDb.rpc('mark_unread', { p_chat_id: chatId })
  if (error) throw new Error(error.message)
  return fromRpc(data, 'mark_unread')
}

export async function markStreamRead(
  chatId: string,
  streamId: string,
  seq: number,
  threadRootId: string | null = null,
): Promise<StreamReadState> {
  const { data, error } = await chatDb.rpc('mark_stream_read', {
    p_chat_id: chatId,
    p_stream_id: streamId,
    p_seq: seq,
    p_thread_root_id: threadRootId,
  })
  if (error) throw new Error(error.message)
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null
  if (!row || typeof row.stream_id !== 'string') throw new Error('mark_stream_read returned no stream state')
  const lastReadSeq = Number(row.last_read_seq)
  const version = Number(row.version)
  if (!Number.isFinite(lastReadSeq) || !Number.isInteger(version) || typeof row.is_marked_unread !== 'boolean') {
    throw new Error('mark_stream_read returned malformed stream state')
  }
  return { streamId: row.stream_id, lastReadSeq, isMarkedUnread: row.is_marked_unread, version }
}
