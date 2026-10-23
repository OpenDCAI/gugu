/**
 * C3 — 读者不在跟尾状态时,窗口对「越过上界的行」的处理。
 * 不变量:
 * - 窗口含尾(无 hasNewer):越过上界的行就是尾巴在长,接上(自己刚发的确认行不消失、新消息照常进来);
 * - 窗口是离尾历史段(hasNewer):不接(否则窗口里留洞),例外是拉最新页期间自己发的行;
 * - 加载中收到的「钉底」意图不被吞掉,加载结束后恢复跟尾;
 * - 发送动作把窗口钉回底部。
 */
import { describe, expect, it } from 'vitest'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { ChatHistoryWindow } from '../../../../apps/desktop/src/store/chatHistoryWindow'

function row(seq: number, over: Partial<MessageItem> = {}): MessageItem {
  return {
    id: `m-${seq}`, chat_id: 'chat-1', sender_user_id: 'peer', to_user_ids: null, is_whisper: false,
    seq, content: `#${seq}`, content_type: 'text', reply_to_message_id: null, thread_root_id: null,
    is_thread_root: false, retracted_at: null, created_at: '2026-09-23T00:00:00.000Z', reactions: [],
    is_mine: false, delivered: true, delivery_status: null, local_send_state: null, ...over,
  }
}
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => row(from + i))
const seqs = (w: ChatHistoryWindow) => w.getSnapshot().messages.map((m) => m.seq)

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('ChatHistoryWindow 尾部接续 (C3)', () => {
  it('不跟尾但窗口含尾:自己消息的确认行替换乐观行后留在屏上,别人的新消息也进来并计入未读泡', () => {
    const w = new ChatHistoryWindow('owner')
    w.reset('chat-1', range(1, 10))
    const optimistic = row(-1, { id: 'mine', is_mine: true, local_send_state: 'sending' })
    w.update((prev) => [...prev, optimistic])
    w.setFollowingTail(false) // 本视口已发出,等待 ACK 时往上滚
    expect(w.getSnapshot().messages.at(-1)?.id).toBe('mine')

    // 送达:权威行(同 id,seq=11)替换乐观行
    w.update((prev) => prev.map((m) => (m.id === 'mine' ? row(11, { id: 'mine', is_mine: true }) : m)))
    expect(w.getSnapshot().messages.at(-1)).toMatchObject({ id: 'mine', seq: 11 })

    w.update((prev) => [...prev, row(12)])
    expect(seqs(w).slice(-2)).toEqual([11, 12])
    expect(w.getSnapshot().hasNewer).toBe(false)
    expect(w.getSnapshot().newMessageCount).toBe(1)
  })

  it('阴控:离尾的历史段不接越过上界的别人消息(不在窗口里留洞),只亮 hasNewer', async () => {
    const w = new ChatHistoryWindow('owner')
    w.reset('chat-1', range(1, 10))
    await w.restoreAnchor(async () => ({ messages: range(1, 10), hasNewer: true })) // 定位到一段历史,尾部之后还有
    expect(w.getSnapshot().hasNewer).toBe(true)
    w.update((prev) => [...prev, row(50)])
    expect(seqs(w)).toEqual(range(1, 10).map((m) => m.seq))
    expect(w.getSnapshot().hasNewer).toBe(true)
  })

  it('发送钉底:窗口含尾 ⇒ 立即恢复跟尾', () => {
    const w = new ChatHistoryWindow('owner')
    w.reset('chat-1', range(1, 10))
    w.setFollowingTail(false)
    const before = w.getSnapshot()
    expect(w.followForSend()).toBe(true)
    expect(w.isFollowingTail()).toBe(true)
    expect(w.getSnapshot()).toMatchObject({ navigation: 'latest', navigationVersion: before.navigationVersion + 1,
      viewVersion: before.viewVersion, messages: before.messages })
  })

  it('发送钉底:离尾 ⇒ 交给回最新页;拉取期间自己的确认行不消失,并进最新页', async () => {
    const w = new ChatHistoryWindow('owner')
    w.reset('chat-1', range(1, 10))
    await w.restoreAnchor(async () => ({ messages: range(1, 10), hasNewer: true }))
    const before = w.getSnapshot()
    expect(w.followForSend()).toBe(false)
    expect(w.getSnapshot()).toBe(before)

    const pages = [deferred<MessageItem[]>(), deferred<MessageItem[]>()]
    let calls = 0
    const loading = w.load('latest', () => pages[calls++]!.promise)
    w.update((prev) => [...prev, row(-1, { id: 'mine', is_mine: true, local_send_state: 'sending' })])
    // 拉取在途时送达(seq 远超本地上界)
    w.update((prev) => prev.map((m) => (m.id === 'mine' ? row(101, { id: 'mine', is_mine: true }) : m)))
    expect(w.getSnapshot().messages.at(-1)).toMatchObject({ id: 'mine', seq: 101 })
    // 别人的消息也在拉取期间落地(离尾窗口里不接,只记 latestSeen)
    w.update((prev) => [...prev, row(102)])

    pages[0]!.resolve(range(71, 100)) // 服务端读第一页时这两条都还没落库 ⇒ 再读一次
    await Promise.resolve(); await Promise.resolve()
    expect(calls).toBe(2)
    expect(w.getSnapshot().messages.at(-1), '第二页回来之前自己的消息不消失').toMatchObject({ id: 'mine', seq: 101 })
    pages[1]!.resolve([...range(73, 100), row(101, { id: 'mine', is_mine: true }), row(102)])
    await loading
    expect(seqs(w).slice(-3)).toEqual([100, 101, 102])
    expect(w.getSnapshot().hasNewer).toBe(false)
    expect(w.isFollowingTail()).toBe(true)
  })
})

// #6595 切回读到一半、但那一段已不在缓存窗里的会话:整窗换成锚点那一段 = 整列表重挂(与回最新页同一个理由),
// 列表才能在新挂载时直接落在锚点、画同一个落点的替身;不重挂时库还在按旧窗的「最新一条」落位,落完才再滚过去(实测多 ~200ms 空白)。
describe('ChatHistoryWindow 恢复锚点', () => {
  it('锚点那一段换进窗口时视图版本加一;失败不动', async () => {
    const w = new ChatHistoryWindow('owner')
    w.reset('chat-1', range(61, 100))
    const version = w.getSnapshot().viewVersion
    expect(await w.restoreAnchor(async () => ({ messages: range(1, 40), hasNewer: true }))).toBe(true)
    expect(seqs(w).slice(0, 2)).toEqual([1, 2])
    expect(w.getSnapshot()).toMatchObject({ navigation: 'anchor', viewVersion: version + 1, hasNewer: true })

    await expect(w.restoreAnchor(async () => { throw new Error('gone') })).rejects.toThrow('gone')
    expect(w.getSnapshot().viewVersion).toBe(version + 1)
  })
})
