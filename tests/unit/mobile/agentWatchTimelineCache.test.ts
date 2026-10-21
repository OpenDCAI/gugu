// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import {
  clearTimelineCache,
  forgetInMemoryTimelines,
  hydrateCachedTimeline,
  readCachedTimeline,
  writeCachedTimeline,
} from '@/mobile/agent-watch/timeline-cache'
import { readCachedSessionList, writeCachedSessionList } from '@/session/shared/remote-sessions/session-list-cache'
import { emptyAgentWatchTimeline } from '@/mobile/agent-watch/agent-watch-store'

/**
 * 手机端的本地留存：进一条会话的第一帧就该有东西，❌ 不是每次都从「正在读取时间线…」开始。
 *
 * owner 2026-09-08 拍板要第一版，2026-09-09 指出第一版存得远远不够：
 * 「手机上应该有个数据库，把这些信息和消息存储起来，这样就不至于每次都要去请求了」。
 * 所以这里的判据分两类：**存得住**（跨重启、够长、连列表一起）与**不撒谎**
 * （结算与游标一起存、裁剪要如实报、没存过就是没有）。
 */
const KEY = { deviceId: 'd1', sessionId: 'c1' }

function turn(id: string, text: string): TranscriptTurn {
  return {
    id,
    role: 'assistant',
    startedAt: 1,
    outcome: null,
    items: [{ kind: 'message', id: `${id}-m`, seq: 1, role: 'assistant', text }],
  } as unknown as TranscriptTurn
}

function timelineOf(turns: TranscriptTurn[], extra: Partial<ReturnType<typeof emptyAgentWatchTimeline>> = {}) {
  return {
    ...emptyAgentWatchTimeline(),
    cursor: { epoch: 'e1', seq: 7 },
    turns,
    ...extra,
  }
}

describe('手机端本地留存', () => {
  beforeEach(async () => {
    await clearTimelineCache()
  })

  it('存了就能读回来:游标与轮次原样,进页第一帧就有内容', () => {
    writeCachedTimeline(KEY, timelineOf([turn('t1', '你好'), turn('t2', '在的')]))
    const restored = readCachedTimeline(KEY)
    expect(restored?.cursor).toEqual({ epoch: 'e1', seq: 7 })
    expect(restored?.turns.map((t) => t.id)).toEqual(['t1', 't2'])
  })

  it('跨重启也在 —— 进程内那层清掉后，仍然从本地库里读得回来', async () => {
    writeCachedTimeline(KEY, timelineOf([turn('t1', '你好'), turn('t2', '在的')]))
    // 让写入落到库里再模拟冷启动：只丢进程内那层，库里那份留着。
    await Promise.resolve()
    forgetInMemoryTimelines()
    // 同步那一层此刻必须是空的,否则下面读到的可能仍是内存命中,库里存没存下来就判不出来。
    expect(readCachedTimeline(KEY)).toBeNull()
    const restored = await hydrateCachedTimeline(KEY)
    expect(restored?.turns.map((t) => t.id)).toEqual(['t1', 't2'])
  })

  it('存得下长会话 —— 30 轮一轮不少，❌ 不再掐在十来轮上', async () => {
    const many = Array.from({ length: 30 }, (_, i) => turn(`t${i}`, `第 ${i} 轮`))
    writeCachedTimeline(KEY, timelineOf(many, { hasOlder: false }))
    await Promise.resolve()
    forgetInMemoryTimelines()
    const restored = await hydrateCachedTimeline(KEY)
    expect(restored?.turns.length).toBe(30)
    // 一轮没丢 ⇒ 也就 ❌ 不许谎称「前面还有更早的」。
    expect(restored?.hasOlder).toBe(false)
  })

  it('真的超了上限才从头砍，并如实报「前面还有更早的」', () => {
    // 每轮约 200KB × 30 = 6MB，越过单条 4MB 的线。
    const heavy = Array.from({ length: 30 }, (_, i) => turn(`t${i}`, 'x'.repeat(200_000)))
    writeCachedTimeline(KEY, timelineOf(heavy, { hasOlder: false }))
    const restored = readCachedTimeline(KEY)
    expect(restored?.turns.length).toBeLessThan(heavy.length)
    // 砍的是**最早**那些:最新一轮必须还在,它才是进页要看的那一屏。
    expect(restored?.turns.at(-1)?.id).toBe('t29')
    expect(restored?.hasOlder).toBe(true)
  })

  it('结算与游标一起存:再进来时游标之前就在等人答的提问还在(内存与跨重启两层)', async () => {
    const pending = { itemId: 'i1', state: 'pending', kind: 'question' } as never
    writeCachedTimeline(KEY, timelineOf([turn('t1', '选哪个?')], { settlements: { i1: pending } }))
    // 对账只补游标之后变过的结算;游标之前的那条只能从这里来 —— 丢了,卡片就再也回不来(2026-10-02 真机)。
    expect(readCachedTimeline(KEY)?.settlements).toEqual({ i1: pending })
    await Promise.resolve()
    forgetInMemoryTimelines()
    expect((await hydrateCachedTimeline(KEY))?.settlements).toEqual({ i1: pending })
  })

  it('旧版存的行(有游标、没结算)当没有:它的游标盖不住结算,只能整份拉', async () => {
    const { getAgentWatchStore } = await import('@/session/shared/remote-sessions/local-store')
    const store = await getAgentWatchStore()
    await store.put('timeline', {
      key: 'd1:c1', savedAt: 1, cursor: { epoch: 'e1', seq: 7 }, turns: [turn('t1', '旧的')], hasOlder: false, bytes: 1,
    } as never)
    forgetInMemoryTimelines()
    expect(await hydrateCachedTimeline(KEY)).toBeNull()
  })

  it('会话列表也存 —— 冷启动第一眼是上次那张表,不是「正在读取」', async () => {
    writeCachedSessionList('d1', {
      projects: [{ id: 'p1', name: '仓库' }],
      sessions: [{ id: 's1', title: '改 bug' }],
    })
    await Promise.resolve()
    const stored = await readCachedSessionList<{ id: string }, { id: string }>('d1')
    expect(stored?.sessions.map((s) => s.id)).toEqual(['s1'])
    expect(stored?.projects.map((p) => p.id)).toEqual(['p1'])
  })

  it('阴控:没存过就是没有 —— ❌ 不返回一份空时间线冒充「这条会话没内容」', () => {
    expect(readCachedTimeline({ deviceId: 'd1', sessionId: 'never-seen' })).toBeNull()
    // 空的那份也不存:存了就会画出一张空白页,而空白页与「读不到」在屏幕上一模一样。
    writeCachedTimeline(KEY, timelineOf([]))
    expect(readCachedTimeline(KEY)).toBeNull()
  })
})

/**
 * 写入是**跟着流式消息**发生的（每 1.5 秒一次）。所以这一层自己不能重：
 * 早先的实现每写一次就把整份历史读出来算总量，那等于把这一批要消灭的那种卡
 * 亲手加回到写入路径上。判据是「写很多次，也不会去翻整份历史」。
 */
describe('留存自己不能变成新的卡', () => {
  beforeEach(async () => {
    await clearTimelineCache()
  })

  it('连写多次不会每次都去翻整份历史', async () => {
    const { getAgentWatchStore } = await import('@/session/shared/remote-sessions/local-store')
    const store = await getAgentWatchStore()
    const readAll = store.readAll.bind(store)
    let scans = 0
    store.readAll = async (name) => {
      if (name === 'timeline') scans += 1
      return readAll(name)
    }
    try {
      for (let i = 0; i < 20; i += 1) {
        writeCachedTimeline(KEY, timelineOf([turn(`t${i}`, `第 ${i} 轮`)]))
        await Promise.resolve()
      }
      // 大小记在一份几百字节的目录里,❌ 不是每次都整份读回来。
      expect(scans).toBe(0)
    } finally {
      store.readAll = readAll
    }
  })

  // 复核 47b50d577:超了上限以后每丢一轮都整份 JSON.stringify 一次,一次写从 1 ms 涨到 40 多 ms。
  it('超了上限也只把各轮量一次,❌ 每丢一轮整份再序列化一遍', () => {
    const heavy = Array.from({ length: 30 }, (_, i) => turn(`t${i}`, 'x'.repeat(200_000)))
    const stringify = vi.spyOn(JSON, 'stringify')
    try {
      writeCachedTimeline(KEY, timelineOf(heavy))
      const serialized = stringify.mock.results.reduce((sum, result) => sum + (typeof result.value === 'string' ? result.value.length : 0), 0)
      expect(readCachedTimeline(KEY)?.hasOlder).toBe(true)
      // 整份约 6M 字:量一遍就是 6M;每丢一轮重量一遍是 6M + 5.8M + … ≈ 55M。
      expect(serialized).toBeLessThan(7_000_000)
    } finally {
      stringify.mockRestore()
    }
  })
})

// owner 10-15 手机流量:工具交回的图手机按张去机器上取,取到的写回条目、跟着留存存。图能按张再取,一轮字丢了要整段重翻 ——
// 所以超了上限先拿掉最旧轮次里取回来的图(refs 留着),还装不下才丢整轮(155 10-15 加的一条)。
describe('留存超了上限:先拿图,再丢轮', () => {
  beforeEach(async () => {
    await clearTimelineCache()
  })

  /** 一轮:一句话 + 一次交回一张图的调用,图已经取回来写进条目了。 */
  function pictureTurn(id: string, chars: number, refs = true): TranscriptTurn {
    return {
      id,
      role: 'assistant',
      startedAt: 1,
      outcome: null,
      items: [
        { kind: 'message', id: `${id}-m`, seq: 1, role: 'assistant', text: `第 ${id} 轮` },
        { kind: 'mcp-tool-call', id: `${id}-tool`, seq: 2, toolCallId: `${id}-tool`, title: 'app_check', status: 'done', images: [{ mimeType: 'image/jpeg', data: 'x'.repeat(chars) }], ...(refs ? { imageRefs: [{ mimeType: 'image/jpeg', chars }] } : {}) },
      ],
    } as unknown as TranscriptTurn
  }
  const toolOf = (t: TranscriptTurn | undefined) => t?.items[1] as unknown as { images?: unknown[]; imageRefs?: unknown[] }

  it('30 轮各带一张 200K 字的图(6M):一轮不丢,最旧的那些轮拿掉了图、refs 还在,最新一轮的图还在', () => {
    const turns = Array.from({ length: 30 }, (_, i) => pictureTurn(`t${i}`, 200_000))
    writeCachedTimeline(KEY, timelineOf(turns, { hasOlder: false }))
    const restored = readCachedTimeline(KEY)!
    expect(restored.turns).toHaveLength(30)
    expect(restored.hasOlder).toBe(false)
    expect(toolOf(restored.turns[0]).images).toBeUndefined()
    expect(toolOf(restored.turns[0]).imageRefs).toHaveLength(1)
    expect(toolOf(restored.turns.at(-1)).images).toHaveLength(1)
    // 拿到装得下就停:留下的仍在 4MB 以内,而且不是把图拿光了。
    expect(JSON.stringify(restored.turns).length).toBeLessThanOrEqual(4 * 1024 * 1024)
    expect(restored.turns.filter((t) => toolOf(t).images).length).toBeGreaterThan(15)
  })

  // 复核·二代 10-16:按轮拿,最新一轮两次 4×512K 就整轮 8 张都拿掉了,冷启动要重取 8 张;只要拿掉 2 张就装得下。
  it('按张拿、拿够就停:一轮两次各 4 张、每张 600K(4.8M),只拿掉 2 张,别的 6 张和 refs 都在,一轮不丢', () => {
    const shots = (n: number) => Array.from({ length: n }, () => ({ mimeType: 'image/jpeg', data: 'x'.repeat(600_000) }))
    const refs = (n: number) => Array.from({ length: n }, () => ({ mimeType: 'image/jpeg', chars: 600_000 }))
    const heavy = {
      id: 't0', role: 'assistant', startedAt: 1, outcome: null,
      items: [
        { kind: 'message', id: 't0-m', seq: 1, role: 'assistant', text: '查两遍' },
        { kind: 'mcp-tool-call', id: 't0-a', seq: 2, toolCallId: 't0-a', title: 'app_check', status: 'done', images: shots(4), imageRefs: refs(4) },
        { kind: 'mcp-tool-call', id: 't0-b', seq: 3, toolCallId: 't0-b', title: 'app_check', status: 'done', images: shots(4), imageRefs: refs(4) },
      ],
    } as unknown as TranscriptTurn
    writeCachedTimeline(KEY, timelineOf([heavy], { hasOlder: false }))
    const restored = readCachedTimeline(KEY)!
    expect(restored.turns).toHaveLength(1)
    expect(restored.hasOlder).toBe(false)
    const calls = restored.turns[0]!.items.slice(1) as unknown as { images?: unknown[]; imageRefs?: unknown[] }[]
    expect(calls.map((c) => (c.images ?? []).filter(Boolean).length)).toEqual([2, 4])
    expect(calls.map((c) => c.imageRefs?.length)).toEqual([4, 4])
    expect(JSON.stringify(restored.turns).length).toBeLessThanOrEqual(4 * 1024 * 1024)
  })

  it('没有 refs 的图不拿(拿掉就再也取不回来):照旧从最旧的整轮丢', () => {
    const turns = Array.from({ length: 30 }, (_, i) => pictureTurn(`t${i}`, 200_000, false))
    writeCachedTimeline(KEY, timelineOf(turns, { hasOlder: false }))
    const restored = readCachedTimeline(KEY)!
    expect(restored.turns.length).toBeLessThan(30)
    expect(restored.hasOlder).toBe(true)
    expect(restored.turns.every((t) => toolOf(t).images)).toBe(true)
  })
})
