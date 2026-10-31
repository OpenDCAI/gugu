import { platform } from '@/platform'
import { chatDb } from './supabase'

declare const brand: unique symbol
/** 云端会话的消息序号(chat.messages.seq,主线与话题共用一个计数)。 */
export type ChatSeq = number & { readonly [brand]: 'ChatSeq' }
/** 本机会话时间线里一条可读气泡的 item id;由宿主 journal 换成 native key,❌ 与 ChatSeq 混用。 */
export type NativeItemId = string & { readonly [brand]: 'NativeItemId' }

export function chatSeq(value: number): ChatSeq {
  if (!Number.isInteger(value) || value < 0) throw new Error(`chat seq must be a non-negative integer, got ${value}`)
  return value as ChatSeq
}

export function nativeItemId(value: string): NativeItemId {
  return value as NativeItemId
}

/**
 * 「已读」写到哪里。云端两种流同一个 RPC(mark_stream_read:主线与 mark_read 同一条 UPDATE,话题写流读位);
 * 本机会话写宿主 journal(桌面与手机共用)。
 */
export type ReadTarget =
  | { kind: 'main'; chatId: string; seq: ChatSeq }
  | { kind: 'thread'; chatId: string; rootId: string; seq: ChatSeq }
  | { kind: 'native'; deviceId: string | null; conversationId: string; itemIds: readonly NativeItemId[] }
  /** 发给你的一条消息你看到了:发送方那边的逐条已读(chat.message_deliveries),与读位是两件事。 */
  | { kind: 'receipt'; chatId: string; messageId: string; readerUserId: string }

/** 云端一条流的读位:没有话题根就是主线。 */
export function cloudReadTarget(chatId: string, rootId: string | null, seq: number): ReadTarget {
  return rootId ? { kind: 'thread', chatId, rootId, seq: chatSeq(seq) } : { kind: 'main', chatId, seq: chatSeq(seq) }
}

/**
 * 已读的**唯一写入口**。服务端读位单调只增,这里不守卫也不回滚:守卫(陈旧 seq 不发)与乐观 patch 的回滚
 * 归调用方(advanceReadWatermark)。失败一律抛。
 */
export async function writeRead(target: ReadTarget): Promise<void> {
  switch (target.kind) {
    case 'main':
      return markCloudStreamRead(target.chatId, `main:${target.chatId}`, target.seq, null)
    case 'thread':
      return markCloudStreamRead(target.chatId, `thread:${target.chatId}:${target.rootId}`, target.seq, target.rootId)
    case 'native': {
      const api = platform.kind === 'electron'
        ? (await import('@/session/renderer/lib/ipc')).rpcOn(target.deviceId).sessionTimeline
        : (await import('@/mobile/agent-watch/sessionpage-rpc')).machineRpc(target.deviceId!).sessionTimeline
      await api.sessionVisible({ conversationId: target.conversationId, itemIds: [...target.itemIds] })
      return
    }
    case 'receipt': {
      // 服务端对「消息还看不到」是 no-op,不抛;抛出来的都是真错误。
      const { error } = await chatDb.rpc('mark_message_read', { p_chat_id: target.chatId, p_message_id: target.messageId, p_agent_user_id: target.readerUserId })
      if (error) throw new Error(error.message)
      return
    }
  }
}

async function markCloudStreamRead(chatId: string, streamId: string, seq: ChatSeq, threadRootId: string | null): Promise<void> {
  const { data, error } = await chatDb.rpc('mark_stream_read', {
    p_chat_id: chatId,
    p_stream_id: streamId,
    p_seq: seq,
    p_thread_root_id: threadRootId,
  })
  if (error) throw new Error(error.message)
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null
  if (!row || row.stream_id !== streamId) throw new Error(`mark_stream_read returned no state for ${streamId}`)
}
