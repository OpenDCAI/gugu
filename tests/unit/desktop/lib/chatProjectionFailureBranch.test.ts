// @vitest-environment node
// @@@chat-projection 失败支 —— 判据边界上的确定性阳控/阴控(#5394 ③)。
import { describe, expect, it, vi, beforeEach } from 'vitest'
type Response = { data: unknown; error: { message: string } | null }
const calls: string[] = []
/** key(表名 / `rpc:<fn>`)→ 还要失败几发。一发 = 一个有界批。 */
const faults = new Map<string, number>()
const rowsByKey = new Map<string, unknown[]>()
function resultFor(key: string): Promise<Response> {
  const pending = faults.get(key) ?? 0
  if (pending > 0) {
    faults.set(key, pending - 1)
    calls.push(`${key}!FAIL`)
    return Promise.resolve({ data: null, error: { message: 'TypeError: Failed to fetch' } })
  }
  calls.push(key)
  return Promise.resolve({ data: rowsByKey.get(key) ?? [], error: null })
}
/** 任意长度的链式调用都返回自己,await 时才结算 —— 产品加一个 `.order()` 不该让装置失效。 */
function builder(key: string): unknown {
  const chain: unknown = new Proxy(function noop() {} as unknown as object, {
    get(_target, prop) {
      if (prop === 'then') {
        return (onFulfilled: (value: Response) => unknown, onRejected?: (reason: unknown) => unknown) =>
          resultFor(key).then(onFulfilled, onRejected)
      }
      return () => chain
    },
    apply: () => chain,
  })
  return chain
}
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({
  chatDb: {
    from: (table: string) => builder(table),
    rpc: (fn: string) => builder(`rpc:${fn}`),
  },
  identityDb: {
    from: (table: string) => builder(table),
    rpc: (fn: string) => builder(`rpc:${fn}`),
  },
}))
vi.mock('../../../../apps/desktop/src/lib/identityReadAdapter', () => ({
  readDisplayIdentities: async (ids: readonly string[]) => {
    const pending = faults.get('identity') ?? 0
    if (pending > 0) {
      faults.set('identity', pending - 1)
      calls.push('identity!FAIL')
      throw new Error('TypeError: Failed to fetch')
    }
    calls.push('identity')
    return ids.map((id) => ({ id, display_name: `name-${id}`, type: 'human' }))
  },
}))
const { createChatProjection } = await import('../../../../apps/desktop/src/lib/chatProjection')
const { FAMILY_BATCH_KEYS } = await import('../../../../apps/desktop/src/lib/chatProjectionAlgebra')
const VIEWER = 'u-viewer'
const chatId = (i: number) => `c-${String(i).padStart(4, '0')}`
/** N 条已发布进收件箱的群聊,成员只有 viewer ⇒ assemble 不需要对端身份即可发布。 */
function seedWorld(n: number): void {
  rowsByKey.clear()
  rowsByKey.set('chat_members', Array.from({ length: n }, (_, i) => ({
    chat_id: chatId(i), user_id: VIEWER, last_read_seq: 0, is_marked_unread: false, version: 1,
    notification_level: 'all', is_pinned: false, updated_at: '2026-09-11T00:00:00Z',
    joined_at: '2026-09-11T00:00:00Z', inbox_published_at: '2026-09-11T00:00:00Z',
  })))
  rowsByKey.set('chats', Array.from({ length: n }, (_, i) => ({
    id: chatId(i), public_id: null, kind: 'group', status: 'active', name: `G${i}`, avatar_url: null,
    created_at: '2026-09-11T00:00:00Z', last_message_at: null, last_message_preview: null,
    next_message_seq: 1, pinned_message_id: null,
  })))
  rowsByKey.set('messages_view', [])
  rowsByKey.set('rpc:list_unread_locators', [])
  rowsByKey.set('contact_overrides', [])
}
const failedRows = (projection: { ledger: () => readonly { ok: boolean }[] }) =>
  projection.ledger().filter((entry) => !entry.ok)
describe('chat projection 失败支 —— 一波失败 ⇒ 账本一行 ok:false + 键回 dirty + 重 hydrate', () => {
  beforeEach(() => {
    calls.length = 0
    faults.clear()
  })
  it('阴控:不注入 ⇒ 跑完、发布出行、账本一行都不是 ok:false', async () => {
    seedWorld(3)
    const projection = createChatProjection(VIEWER)
    const rows = await projection.hydrate('0', new AbortController().signal)
    expect(rows).toHaveLength(3)
    expect(failedRows(projection)).toHaveLength(0)
    expect(projection.ledger().filter((e) => e.trigger.includes('hydrate'))).toHaveLength(1)
    expect(calls.some((c) => c.endsWith('!FAIL'))).toBe(false)
  })
  it('阳控:一波里**一发**失败 ⇒ hydrate 响亮抛出,账本恰**一行** ok:false(不是每发一行)', async () => {
    const total = 150
    const batches = Math.ceil(total / FAMILY_BATCH_KEYS.chat)
    expect(batches).toBeGreaterThan(1) // 阳控:这一格真的有多发,否则「一发 vs 一波」测不出来
    seedWorld(total)
    faults.set('chats', 1)
    const projection = createChatProjection(VIEWER)
    await expect(projection.hydrate('0', new AbortController().signal))
      .rejects.toThrow(/Failed to fetch/)
    const failed = failedRows(projection)
    expect(failed).toHaveLength(1)
    const row = failed[0] as { ok: boolean; error?: string; trigger: string[]; waves: number }
    expect(row.trigger).toContain('hydrate')
    expect(row.error).toMatch(/Failed to fetch/)
    expect(row.waves).toBeGreaterThan(0)
    expect(calls.filter((c) => c === 'chats').length).toBe(batches - 1)
    expect(calls.filter((c) => c === 'chats!FAIL').length).toBe(1)
  })
  it('失败之后:键回 dirty + 快照戳未前进 ⇒ 下一次 wake 重新 hydrate 并收敛', async () => {
    seedWorld(3)
    faults.set('chats', 1)
    const projection = createChatProjection(VIEWER)
    await expect(projection.hydrate('0', new AbortController().signal)).rejects.toThrow()
    expect(failedRows(projection)).toHaveLength(1)
    expect(projection.current()).toHaveLength(0) // 空列表 —— 但**不是终态**
    calls.length = 0
    const next = await projection.advance(
      [{ revision: '5', event: 'chat_changed', chatId: chatId(0), entityId: null }],
      '5',
      new AbortController().signal,
    )
    expect(next).not.toBeNull()
    expect(next).toHaveLength(3)
    const rebuild = projection.ledger().filter((e) => e.trigger.includes('hydrate'))
    expect(rebuild.length).toBeGreaterThanOrEqual(2)
    expect(rebuild[rebuild.length - 1]!.ok).toBe(true)
    expect(calls.filter((c) => c === 'chats').length).toBeGreaterThan(0)
    expect(projection.current()).toHaveLength(3)
  })
  it('成功之后同一游标再 hydrate ⇒ 重放免费,且不产生第二行(与失败支互不干扰)', async () => {
    seedWorld(2)
    const projection = createChatProjection(VIEWER)
    await projection.hydrate('7', new AbortController().signal)
    calls.length = 0
    const again = await projection.hydrate('7', new AbortController().signal)
    expect(again).toHaveLength(2)
    expect(calls).toHaveLength(0) // 一发都不打
    expect(projection.ledger().filter((e) => e.trigger.includes('hydrate'))).toHaveLength(1)
  })
})
