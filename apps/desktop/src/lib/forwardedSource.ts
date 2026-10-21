// @@@5856 转发的出处 ——「引自:某某线」(product spec「跨线引用别处的内容时在界面上留痕」)。
//
// 为什么要一层缓存:出处是**逐条消息**的属性,而一屏可能有很多条转发消息,不缓存就是每次重绘
// 都重新问一遍。按 message id 缓存,跨会话有效(消息 id 全局唯一,一条消息的出处不会变)。
//
// ⚠️ 同一个 microtask 里聚起来的那一批仍然是**一条消息一次 RPC**,只是起跑时间对齐、且同一条
// 消息不会并发问两次 —— ❌ 别把它说成「一屏一次往返」,chat.forwarded_source 只收一个 id。
// 真要合批得先加一个收 id 数组的 RPC;一屏转发消息通常个位数,先不加。
//
// 读不到就是读不到:chat.forwarded_source 是 SECURITY INVOKER,读者看不见来源那条线时它返回空行 ——
// 那时界面退回只显「转发」。❌ 不把「你无权看见」渲染成「未知来源」,两者在用户那里意思不同。
import { chatDb } from './supabase'

export type ForwardedSource = { chatId: string; kind: string; name: string | null }

export const forwardedSourceCache = new Map<string, ForwardedSource | null>()
const subscribers = new Map<string, Set<() => void>>()
let pending: Set<string> | null = null

async function resolveOne(messageId: string): Promise<void> {
  let value: ForwardedSource | null = null
  let resolved = false
  try {
    const { data, error } = await chatDb.rpc('forwarded_source', { p_message_id: messageId })
    if (!error) {
      resolved = true
      const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined
      const chatId = typeof row?.source_chat_id === 'string' ? row.source_chat_id : null
      if (chatId) {
        value = {
          chatId,
          kind: typeof row?.source_chat_kind === 'string' ? row.source_chat_kind : 'group',
          name: typeof row?.source_chat_name === 'string' ? row.source_chat_name : null,
        }
      }
    }
  } catch {
    // 出处解析失败不该影响消息本身的渲染 —— 退回只显「转发」。
    value = null
  }
  // 只缓存**读到了**的结果。失败也写进去的话,一次网络抖动就让这条消息的「引自」永远不再出现
  // (requestForwardedSource 只看 has()),而那是一条永远不会自愈的静默降级。
  if (resolved) forwardedSourceCache.set(messageId, value)
  for (const notify of subscribers.get(messageId) ?? []) notify()
}

export function requestForwardedSource(messageId: string): void {
  if (forwardedSourceCache.has(messageId)) return
  if (pending) {
    pending.add(messageId)
    return
  }
  pending = new Set([messageId])
  // 聚到同一个 microtask 之后再发:一屏渲染完再一起起跑(仍是每条一次 RPC,见文件头)。
  queueMicrotask(() => {
    const batch = pending ?? new Set<string>()
    pending = null
    for (const id of batch) if (!forwardedSourceCache.has(id)) void resolveOne(id)
  })
}

/** 订阅某条消息出处解析完成的通知;返回退订。渲染期取值走 forwardedSourceCache。 */
export function subscribeForwardedSource(messageId: string, listener: () => void): () => void {
  let listeners = subscribers.get(messageId)
  if (!listeners) {
    listeners = new Set()
    subscribers.set(messageId, listeners)
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) subscribers.delete(messageId)
  }
}

/** 测试用:清掉进程内缓存。产品路径不调它 —— 一条消息的出处不会变。 */
export function resetForwardedSourceCacheForTests(): void {
  forwardedSourceCache.clear()
  subscribers.clear()
  pending = null
}
