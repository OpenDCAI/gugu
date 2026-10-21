// @@@chat-projection 测试替身 —— **一个缝**,不是每个文件一个。
//
// 会话列表只有一个属主(spec I7):冷启快照与增量都走投影。所以想在测试里表达
// 「服务端此刻的会话列表是什么」,就在**投影这一个缝**上表达 —— ❌ 不再打桩
// `chatService.getChats`(那条 8 波串行链已经删掉,它本身就是第二个属主)。
//
// 这些判据守的是 **store 怎么消费投影**,不是投影自己的代数。

import { vi } from 'vitest'

/** 投影认领的那组 event(替身里写一份:被 mock 的模块拿不到真常量)。 */
export const PROJECTED_EVENTS_STUB = [
  'chat_changed', 'chat_meta_changed', 'chat_members_changed',
  'member_read_changed', 'member_stream_read_changed',
  'message_created', 'message_deleted', 'reaction_changed', 'delivery_changed',
  'agent_changed', 'friendship_changed',
] as const

export type ChatProjectionStub = {
  /** 服务端此刻的会话列表(hydrate 与 advance 默认都交这个)。 */
  rows: unknown[]
  identityRows: unknown[]
  /** 权威地「我已不在这条会话里」—— #4314 的撤销判据。 */
  revoked: Set<string>
  /** 覆盖某一次推进的结果(返回 null = 键已新鲜,零发零重绘)。 */
  advanceImpl: null | (() => Promise<unknown[] | null>)
  /** 覆盖冷启快照(默认交 rows)。 */
  hydrateImpl: null | (() => Promise<unknown[]>)
  hydrateCalls: number
  reset(): void
}

export function createChatProjectionStub(): ChatProjectionStub {
  const stub: ChatProjectionStub = {
    rows: [], identityRows: [], revoked: new Set(),
    advanceImpl: null, hydrateImpl: null, hydrateCalls: 0,
    reset() {
      stub.rows = []
      stub.identityRows = []
      stub.revoked = new Set()
      stub.advanceImpl = null
      stub.hydrateImpl = null
      stub.hydrateCalls = 0
    },
  }
  return stub
}

/**
 * `vi.mock('…/lib/chatProjection', () => chatProjectionModuleStub(() => stub))` 的模块面。
 * ⚠️ 收的是**取值函数**而不是替身本体:`vi.mock` 的 factory 会被提到文件顶部,
 * 直接传本体会在模块初始化前读它 ⇒ `Cannot access 'projectionStub' before initialization`。
 */
export function chatProjectionModuleStub(read: () => ChatProjectionStub) {
  return {
    createChatProjection: () => ({
      hydrate: async () => {
        read().hydrateCalls += 1
        const stub = read()
        return stub.hydrateImpl ? await stub.hydrateImpl() : stub.rows
      },
      advance: async () => { const stub = read(); return stub.advanceImpl ? stub.advanceImpl() : stub.rows },
      ingestLocalWrite: () => read().rows,
      // 替身也走真接线的形状:认领一组 event → **一次**推进 → 把行交给 store 发布。
      attach: ({ subscribe, cursor, signal, publish }: {
        subscribe: (events: readonly string[], listener: (operations: readonly unknown[]) => void | Promise<void>) => () => void
        cursor: () => string
        signal: () => AbortSignal
        publish: (rows: unknown[]) => Promise<void>
      }) => subscribe(PROJECTED_EVENTS_STUB, async () => {
        cursor(); signal()
        const stub = read()
        const rows = stub.advanceImpl ? await stub.advanceImpl() : stub.rows
        if (rows !== null) await publish(rows)
      }),
      current: () => read().rows,
      identities: () => read().identityRows,
      isMembershipRevoked: (chatId: string) => read().revoked.has(chatId),
      ledger: () => [],
      reset: () => undefined,
    }),
    parseWakeHead: () => null,
    readProjectionCursor: () => '0',
    toProjectionOperations: (operations: readonly unknown[]) => operations,
    PROJECTED_REVISION_EVENTS: PROJECTED_EVENTS_STUB,
  }
}

/**
 * coordinator 替身的 subscribe:认领一组 event 的 consumer(投影就是)注册一次,
 * 这里摊平回按 event 索引,好让用例仍能按事件名驱动。
 */
export function fanOutRevisionSubscribe(
  listeners: Map<string, (operations: readonly unknown[]) => void | Promise<void>>,
) {
  return vi.fn((events: string | readonly string[], listener: (operations: readonly unknown[]) => void | Promise<void>) => {
    const claimed = typeof events === 'string' ? [events] : [...events]
    for (const event of claimed) listeners.set(event, listener)
    return () => { for (const event of claimed) listeners.delete(event) }
  })
}
