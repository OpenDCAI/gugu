import { describe, expect, it } from 'vitest'
import { createAttachmentResolver, REFRESH_MARGIN_MS, URLS_BATCH_MAX, type AttachmentUrlRef } from '@gugu/core/shared/attachmentUrls'

// 假的 attachments/urls:记下每次收到的 refs;给的条目才回,别的当看不见。
function fakeUrls(opts: { known?: (itemId: string) => boolean; expiresAt?: string; fail?: () => boolean } = {}) {
  const calls: AttachmentUrlRef[][] = []
  const fetchUrls = async (refs: AttachmentUrlRef[]) => {
    calls.push(refs)
    if (opts.fail?.()) throw new Error('attachments/urls 503')
    return {
      urls: refs.flatMap((r) => ('item_id' in r ? [r] : [])).filter((r) => (opts.known ?? (() => true))(r.item_id)).map((r) => ({
        item_id: r.item_id, version: r.version, url: `https://cdn/${r.item_id}?auth_key=${calls.length}`, thumb_url: `https://cdn/${r.item_id}?auth_key=${calls.length}&x-oss-process=t`,
        sha256: 'ab'.repeat(32), width: 800, height: 600, expires_at: opts.expiresAt ?? '2026-10-16T12:30:00.000Z',
      })),
    }
  }
  return { calls, fetchUrls }
}
const manual = () => {
  let pending: (() => void) | null = null
  return { schedule: (f: () => void) => { pending = f }, run: async () => { const f = pending; pending = null; f?.(); await new Promise((r) => setTimeout(r, 0)) } }
}
const item = (itemId: string, version = 1) => ({ kind: 'item' as const, itemId, version })

describe('附件链接只有一个入口', () => {
  it('同一轮要的攒成一批(同一项只要一次);回答里没有的是墓碑;老消息直接用正文里的 URL', async () => {
    const { calls, fetchUrls } = fakeUrls({ known: (id) => id !== 'deleted' })
    const tick = manual()
    const r = createAttachmentResolver(fetchUrls, { schedule: tick.schedule, now: () => Date.parse('2026-10-16T12:00:00Z') })
    const a = r.resolve(item('a')); const a2 = r.resolve(item('a')); const b = r.resolve(item('b', 2)); const d = r.resolve(item('deleted'))
    await tick.run()
    expect(calls).toEqual([[{ item_id: 'a', version: 1 }, { item_id: 'b', version: 2 }, { item_id: 'deleted', version: 1 }]])
    expect(await a).toMatchObject({ status: 'ready', url: 'https://cdn/a?auth_key=1', thumbUrl: 'https://cdn/a?auth_key=1&x-oss-process=t', sha256: 'ab'.repeat(32), width: 800, height: 600 })
    expect(await a2).toEqual(await a)
    expect(await b).toMatchObject({ status: 'ready', url: 'https://cdn/b?auth_key=1' })
    expect(await d).toEqual({ status: 'gone' })
    expect(await r.resolve({ kind: 'url', url: 'https://db/storage/v1/object/public/chat-media/x.png' })).toEqual({ status: 'ready', url: 'https://db/storage/v1/object/public/chat-media/x.png', thumbUrl: null, sha256: null, width: null, height: null })
    expect(await r.resolve({ kind: 'gone' })).toEqual({ status: 'gone' })
    expect(calls).toHaveLength(1)
  })

  it('悄悄话的附件按消息签:refs 里是 { message_id },回答按 message_id 对回去;没回的是墓碑', async () => {
    const calls: unknown[] = []
    const tick = manual()
    const r = createAttachmentResolver(async (refs) => {
      calls.push(refs)
      return { urls: [{ message_id: 'm1', url: 'https://cdn/w1', thumb_url: null, sha256: 'cd'.repeat(32), width: null, height: null, expires_at: '2999-01-01T00:00:00Z' }] }
    }, { schedule: tick.schedule })
    const mine = r.resolve({ kind: 'message', messageId: 'm1' }); const theirs = r.resolve({ kind: 'message', messageId: 'm2' })
    await tick.run()
    expect(calls).toEqual([[{ message_id: 'm1' }, { message_id: 'm2' }]])
    expect(await mine).toMatchObject({ status: 'ready', url: 'https://cdn/w1' })
    expect(await theirs).toEqual({ status: 'gone' })
  })

  it('签好的链接留到过期前一分钟;之后重签。一批最多 200 个', async () => {
    let now = Date.parse('2026-10-16T12:00:00Z')
    const { calls, fetchUrls } = fakeUrls({ expiresAt: '2026-10-16T12:30:00.000Z' })
    const tick = manual()
    const r = createAttachmentResolver(fetchUrls, { schedule: tick.schedule, now: () => now })
    const first = r.resolve(item('a')); await tick.run(); await first
    now = Date.parse('2026-10-16T12:30:00Z') - REFRESH_MARGIN_MS - 1
    expect(await r.resolve(item('a'))).toMatchObject({ url: 'https://cdn/a?auth_key=1' })
    now += 2
    const again = r.resolve(item('a')); await tick.run()
    expect(await again).toMatchObject({ url: 'https://cdn/a?auth_key=2' })
    const many = Array.from({ length: URLS_BATCH_MAX + 5 }, (_, i) => r.resolve(item(`m${i}`)))
    await tick.run(); await Promise.all(many)
    expect(calls.slice(2).map((c) => c.length)).toEqual([URLS_BATCH_MAX, 5])
  })

  it('请求失败:这一批每一项都拒(调用方显示「暂时打不开 · 重试」),不缓存;重试就是再要一次。forget 丢掉记着的墓碑', async () => {
    let failing = true
    const { calls, fetchUrls } = fakeUrls({ fail: () => failing, known: (id) => id !== 'x' || !failing })
    const tick = manual()
    const r = createAttachmentResolver(fetchUrls, { schedule: tick.schedule })
    // 先挂上断言再放行这一轮:拒绝发生在 tick.run() 里,晚挂就成了未处理的拒绝。
    const refused = expect(r.resolve(item('a'))).rejects.toThrow('attachments/urls 503')
    await tick.run()
    await refused
    failing = false
    const retry = r.resolve(item('a')); await tick.run()
    expect(await retry).toMatchObject({ status: 'ready' })
    expect(calls).toHaveLength(2)
    const { fetchUrls: f2 } = fakeUrls({ known: () => false })
    let known = false
    const r2 = createAttachmentResolver(async (refs) => (known ? fakeUrls().fetchUrls(refs) : f2(refs)), { schedule: tick.schedule })
    const g = r2.resolve(item('z')); await tick.run(); expect(await g).toEqual({ status: 'gone' })
    known = true
    expect(await r2.resolve(item('z'))).toEqual({ status: 'gone' })
    r2.forget(item('z'))
    const back = r2.resolve(item('z')); await tick.run(); expect(await back).toMatchObject({ status: 'ready' })
  })

  it('回答不是 { urls: [...] } ⇒ 这一批都拒(fail loud,不当墓碑)', async () => {
    const tick = manual()
    const r = createAttachmentResolver(async () => ({ error: 'not_configured' }), { schedule: tick.schedule })
    const refused = expect(r.resolve(item('a'))).rejects.toThrow('without a urls list')
    await tick.run()
    await refused
  })
})
