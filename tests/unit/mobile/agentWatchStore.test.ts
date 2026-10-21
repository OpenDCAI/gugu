import { describe, expect, it } from 'vitest'
import type { Settlement, TimelineBatch, TimelineSnapshot, TurnPatch } from '@gugu/session-core/session-record/contract'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import {
  applyBatch,
  applySnapshot,
  applyTimelineResult,
  deriveAttention,
  emptyAgentWatchTimeline,
  prependOlder,
  pendingSettlements,
  pinnedSettlements,
  withToolImage,
} from '@/mobile/agent-watch/agent-watch-store'

// 手机看管 agent 的时间线状态机(apps/desktop/src/mobile/agent-watch/agent-watch-store.ts)。
// 这里钉的是「断线只补缺口」在代码里到底意味着什么:
//   ① 同一批喂两次 = 喂一次(重连时重叠的那一段不会变成重复的消息)
//   ② reset 是整份替换(❌ 拼出一份少了中间的)
//   ③ 结算只前进不后退(已答过的不会重新变成可点)

function turn(id: string, seq: number, overrides: Partial<TranscriptTurn> = {}): TranscriptTurn {
  return {
    id,
    seq,
    initiator: 'user',
    items: [{ kind: 'message', id: `${id}-m`, seq: 0, role: 'user', text: `t-${id}` }],
    ...overrides,
  }
}

/** 增量里的一轮是按条目的补丁:完整的条目 id 顺序 + 这批里变过的条目。整轮给出 = 全部条目都在补丁里。 */
function asPatch(t: TranscriptTurn, changed: readonly string[] = t.items.map((i) => i.id)): TurnPatch {
  const { items, ...meta } = t
  return { ...meta, itemIds: items.map((i) => i.id), items: items.filter((i) => changed.includes(i.id)) }
}

function settlement(itemId: string, overrides: Partial<Settlement> = {}): Settlement {
  return {
    itemId,
    kind: 'permission',
    title: `批准 ${itemId}`,
    options: [{ optionId: 'allow', name: '允许', kind: 'allow_once' }],
    state: 'pending',
    optionId: null,
    resolvedBy: null,
    resolvedAt: null,
    ...overrides,
  }
}

const SNAPSHOT: TimelineSnapshot = {
  cursor: { epoch: 'e1', seq: 10 },
  turns: [turn('a', 1), turn('b', 2)],
  settlements: [settlement('a-m')],
  hasOlder: true,
}

describe('agent-watch timeline store', () => {
  it('同一批应用两次,结果与应用一次完全相同', () => {
    const base = applySnapshot(emptyAgentWatchTimeline(), SNAPSHOT)
    const batch: TimelineBatch = {
      from: 10,
      cursor: { epoch: 'e1', seq: 12 },
      turns: [asPatch(turn('b', 2, { items: [{ kind: 'message', id: 'b-m', seq: 0, role: 'assistant', text: '改过的 b' }] })), asPatch(turn('c', 3))],
      removedTurnIds: [],
      settlements: [settlement('a-m', { state: 'resolved', optionId: 'allow', resolvedBy: 'desktop', resolvedAt: 5 })],
    }

    const once = applyBatch(base, batch)
    const twice = applyBatch(once, batch)

    expect(twice).toEqual(once)
    expect(once.turns.map((t) => t.id)).toEqual(['a', 'b', 'c'])
    // 整轮替换:b 拿的是这一批里的那份,不是快照里的旧内容,更不是两份拼起来。
    expect(once.turns[1].items).toHaveLength(1)
    expect((once.turns[1].items[0] as { text: string }).text).toBe('改过的 b')
  })

  it('按条目合并:补丁只带变过的条目,其余沿用手里的,顺序按补丁给的 id 列表', () => {
    const base = applySnapshot(emptyAgentWatchTimeline(), SNAPSHOT)
    const bWithReply: TranscriptTurn = turn('b', 2, {
      items: [
        { kind: 'message', id: 'b-m', seq: 0, role: 'user', text: 't-b' },
        { kind: 'message', id: 'b-r', seq: 1, role: 'assistant', text: '答' },
      ],
    })
    const next = applyBatch(base, {
      from: 10,
      cursor: { epoch: 'e1', seq: 11 },
      turns: [asPatch(bWithReply, ['b-r'])],
      removedTurnIds: [],
      settlements: [],
    })
    expect(next.needsSnapshot).toBeNull()
    const b = next.turns.find((t) => t.id === 'b')!
    expect(b.items.map((i) => i.id)).toEqual(['b-m', 'b-r'])
    expect((b.items[0] as { text: string }).text).toBe('t-b')
    // 再应用一次结果一样(按 id 替换是幂等的)。
    expect(applyBatch(next, {
      from: 10,
      cursor: { epoch: 'e1', seq: 11 },
      turns: [asPatch(bWithReply, ['b-r'])],
      removedTurnIds: [],
      settlements: [],
    })).toEqual(next)
  })

  it('补丁引用了手里没有的条目 ⇒ 中间丢过一批,要求重拉快照', () => {
    const base = applySnapshot(emptyAgentWatchTimeline(), SNAPSHOT)
    const unknownTurn = turn('z', 7, {
      items: [
        { kind: 'message', id: 'z-m', seq: 0, role: 'user', text: 'x' },
        { kind: 'message', id: 'z-r', seq: 1, role: 'assistant', text: 'y' },
      ],
    })
    const next = applyBatch(base, {
      from: 10,
      cursor: { epoch: 'e1', seq: 11 },
      turns: [asPatch(unknownTurn, ['z-r'])],
      removedTurnIds: [],
      settlements: [],
    })
    expect(next.needsSnapshot).toBe('gap')
  })

  it('补丁指向快照窗口之前的一轮(更早的还没翻出来)⇒ 跳过,不当缺口', () => {
    const base = applySnapshot(emptyAgentWatchTimeline(), SNAPSHOT) // hasOlder=true, 最早是 seq 1
    const ancient = turn('ancient', 0, {
      items: [
        { kind: 'message', id: 'an-m', seq: 0, role: 'user', text: 'x' },
        { kind: 'message', id: 'an-r', seq: 1, role: 'assistant', text: 'y' },
      ],
    })
    const next = applyBatch(base, {
      from: 10,
      cursor: { epoch: 'e1', seq: 11 },
      turns: [asPatch(ancient, ['an-r'])],
      removedTurnIds: [],
      settlements: [],
    })
    expect(next.needsSnapshot).toBeNull()
    expect(next.turns.map((t) => t.id)).toEqual(['a', 'b'])
    expect(next.cursor).toEqual({ epoch: 'e1', seq: 11 })
  })

  it('「整份重载」的横幅在下一条正常增量到达后收起', () => {
    const reloaded = applyTimelineResult(emptyAgentWatchTimeline(), {
      ok: false,
      reset: 'gap',
      snapshot: SNAPSHOT,
    })
    expect(reloaded.lastReset).toBe('gap')
    const next = applyBatch(reloaded, {
      from: 10,
      cursor: { epoch: 'e1', seq: 11 },
      turns: [],
      removedTurnIds: [],
      settlements: [],
    })
    expect(next.lastReset).toBeNull()
  })

  it('快照与增量都保留统一时间线的最近动作摘要', () => {
    const base = applySnapshot(emptyAgentWatchTimeline(), {
      ...SNAPSHOT,
      recentActions: ['Read', 'Edit'],
      lastActionAt: 123,
    })
    expect(base.recentActions).toEqual(['Read', 'Edit'])
    expect(base.lastActionAt).toBe(123)

    const next = applyBatch(base, {
      from: 10,
      cursor: { epoch: 'e1', seq: 11 },
      turns: [],
      removedTurnIds: [],
      settlements: [],
      recentActions: ['Bash'],
      lastActionAt: 456,
    })
    expect(next.recentActions).toEqual(['Bash'])
    expect(next.lastActionAt).toBe(456)
  })

  it('排队提示是那台机器上的全集:快照给、增量换;删掉/接走的那一批到了就没了,重放的旧批 ❌ 把它排回去', () => {
    const queued = [{ id: 'qp-1', text: '排着的那句' }]
    const base = applySnapshot(emptyAgentWatchTimeline(), { ...SNAPSHOT, queuedPrompts: queued })
    expect(base.queuedPrompts).toEqual(queued)
    const empty = (seq: number, queuedPrompts?: typeof queued): TimelineBatch => ({
      from: seq - 1,
      cursor: { epoch: 'e1', seq },
      turns: [],
      removedTurnIds: [],
      settlements: [],
      ...(queuedPrompts ? { queuedPrompts } : {}),
    })
    // 老宿主不带这个字段:手里那份不动。
    expect(applyBatch(base, empty(11)).queuedPrompts).toEqual(queued)
    const removed = applyBatch(base, empty(11, []))
    expect(removed.queuedPrompts).toEqual([])
    // 断线重连时重放的那批比手里旧:它报的是当时的队列。
    expect(applyBatch(removed, { ...empty(10, queued), from: 9 }).queuedPrompts).toEqual([])
  })

  it('reset 时用快照整份替换(不与手里那份合并)', () => {
    const stale = applyBatch(applySnapshot(emptyAgentWatchTimeline(), SNAPSHOT), {
      from: 10,
      cursor: { epoch: 'e1', seq: 11 },
      turns: [asPatch(turn('zombie', 9))],
      removedTurnIds: [],
      settlements: [settlement('zombie-m')],
    })
    expect(stale.turns.map((t) => t.id)).toContain('zombie')

    const fresh = applyTimelineResult(stale, {
      ok: false,
      reset: 'source_replaced',
      snapshot: {
        cursor: { epoch: 'e2', seq: 3 },
        turns: [turn('x', 1)],
        settlements: [],
        hasOlder: false,
      },
    })

    expect(fresh.turns.map((t) => t.id)).toEqual(['x'])
    expect(fresh.settlements).toEqual({})
    expect(fresh.cursor).toEqual({ epoch: 'e2', seq: 3 })
    expect(fresh.hasOlder).toBe(false)
    expect(fresh.lastReset).toBe('source_replaced')
  })

  it('结算按 itemId 合并:pending 会被 resolved 覆盖', () => {
    const base = applySnapshot(emptyAgentWatchTimeline(), SNAPSHOT)
    expect(pendingSettlements(base).map((s) => s.itemId)).toEqual(['a-m'])

    const next = applyBatch(base, {
      from: 10,
      cursor: { epoch: 'e1', seq: 11 },
      turns: [],
      removedTurnIds: [],
      settlements: [settlement('a-m', { state: 'resolved', optionId: 'allow', resolvedBy: 'mobile', resolvedAt: 7 })],
    })

    expect(pendingSettlements(next)).toEqual([])
    expect(next.settlements['a-m'].resolvedBy).toBe('mobile')
  })

  it('已了结的结算不会被重放的 pending 重新打开', () => {
    const resolved = applyBatch(applySnapshot(emptyAgentWatchTimeline(), SNAPSHOT), {
      from: 10,
      cursor: { epoch: 'e1', seq: 11 },
      turns: [],
      removedTurnIds: [],
      settlements: [settlement('a-m', { state: 'resolved', optionId: 'allow', resolvedBy: 'desktop', resolvedAt: 7 })],
    })

    const replayed = applyBatch(resolved, {
      from: 9,
      cursor: { epoch: 'e1', seq: 10 },
      turns: [],
      removedTurnIds: [],
      settlements: [settlement('a-m')],
    })

    expect(replayed.settlements['a-m'].state).toBe('resolved')
    expect(pendingSettlements(replayed)).toEqual([])
    // 重放的旧批次也不许把游标拨回去。
    expect(replayed.cursor).toEqual({ epoch: 'e1', seq: 11 })
  })

  it('#6739 抢到了、投递失败:宿主放回待答的那一批(游标前进)把卡放回待答,❌ 停在「已在手机端回答」', () => {
    const answeredHere = settlement('a-m', { state: 'resolved', optionId: 'allow', resolvedBy: 'mobile', resolvedAt: 7 })
    const claimed = applyBatch(applySnapshot(emptyAgentWatchTimeline(), SNAPSHOT), {
      from: 10, cursor: { epoch: 'e1', seq: 11 }, turns: [], removedTurnIds: [], settlements: [answeredHere],
    })
    const released = applyBatch(claimed, {
      from: 11, cursor: { epoch: 'e1', seq: 12 }, turns: [], removedTurnIds: [], settlements: [settlement('a-m')],
    })
    expect(released.settlements['a-m'].state).toBe('pending')
    expect(released.settlements['a-m'].resolvedBy).toBeNull()

    // 反向控:游标**没**前进的同一批(重放)不许把已答翻回去 —— 放宽的只有「宿主此刻的真值」那一路。
    const replayedAtSameSeq = applyBatch(claimed, {
      from: 10, cursor: { epoch: 'e1', seq: 11 }, turns: [], removedTurnIds: [], settlements: [settlement('a-m')],
    })
    expect(replayedAtSameSeq.settlements['a-m']).toEqual(answeredHere)
  })

  it('removedTurnIds 把分叉掉的轮删掉', () => {
    const base = applySnapshot(emptyAgentWatchTimeline(), SNAPSHOT)
    const next = applyBatch(base, {
      from: 10,
      cursor: { epoch: 'e1', seq: 12 },
      turns: [],
      removedTurnIds: ['b'],
      settlements: [],
    })
    expect(next.turns.map((t) => t.id)).toEqual(['a'])
  })

  it('世代不同的增量不合并,而是要求重拉快照', () => {
    const base = applySnapshot(emptyAgentWatchTimeline(), SNAPSHOT)
    const next = applyBatch(base, {
      from: 10,
      cursor: { epoch: 'e2', seq: 1 },
      turns: [asPatch(turn('other', 1))],
      removedTurnIds: [],
      settlements: [],
    })

    expect(next.needsSnapshot).toBe('epoch_changed')
    // 手里那份原封不动 —— ❌ 不拼出一份少了中间的。
    expect(next.turns).toEqual(base.turns)
    expect(next.cursor).toEqual(base.cursor)
  })

  it('断层:这一批从更靠后的位置接上 ⇒ 不合并,要求重拉快照', () => {
    const base = applySnapshot(emptyAgentWatchTimeline(), SNAPSHOT)
    // 手里游标 seq=10,而这一批声称自己从 12 接上 ⇒ 11→12 那一批没到。
    const next = applyBatch(base, {
      from: 12,
      cursor: { epoch: 'e1', seq: 13 },
      turns: [asPatch(turn('later', 5))],
      removedTurnIds: [],
      settlements: [],
    })

    expect(next.needsSnapshot).toBe('gap')
    // 手里那份原封不动 —— 合进去就是 spec 明令禁止的「少了中间的那一份」。
    expect(next.turns).toEqual(base.turns)
    expect(next.cursor).toEqual(base.cursor)
  })

  it('反向控:from 不超过手里的游标时照常合并(判据不是一律拒绝)', () => {
    const base = applySnapshot(emptyAgentWatchTimeline(), SNAPSHOT)
    const contiguous = applyBatch(base, {
      from: 10,
      cursor: { epoch: 'e1', seq: 11 },
      turns: [asPatch(turn('next', 5))],
      removedTurnIds: [],
      settlements: [],
    })
    expect(contiguous.needsSnapshot).toBeNull()
    expect(contiguous.turns.map((t) => t.id)).toContain('next')

    // 重放一批更旧的也照常合并,且不把游标拨回去。
    const replayed = applyBatch(contiguous, {
      from: 9,
      cursor: { epoch: 'e1', seq: 10 },
      turns: [asPatch(turn('a', 1))],
      removedTurnIds: [],
      settlements: [],
    })
    expect(replayed.needsSnapshot).toBeNull()
    expect(replayed.cursor).toEqual({ epoch: 'e1', seq: 11 })
  })

  it('往前翻:更早那批前插进手里这份,顺序不乱、hasOlder 跟着更新', () => {
    const base = applySnapshot(emptyAgentWatchTimeline(), SNAPSHOT)
    expect(base.turns.map((t) => t.id)).toEqual(['a', 'b'])
    expect(base.hasOlder).toBe(true)

    const next = prependOlder(base, {
      epoch: 'e1',
      turns: [turn('older-1', -2), turn('older-2', -1)],
      hasOlder: false,
    })

    expect(next.turns.map((t) => t.id)).toEqual(['older-1', 'older-2', 'a', 'b'])
    expect(next.hasOlder).toBe(false)
    // 翻页不动游标:游标说的是「增量读到哪了」,不是「手里有多少历史」。
    expect(next.cursor).toEqual(base.cursor)
    expect(next.needsSnapshot).toBeNull()
  })

  it('翻页途中宿主换过代 ⇒ 整批丢掉并要求重拉,❌ 不前插一段接不上的', () => {
    const base = applySnapshot(emptyAgentWatchTimeline(), SNAPSHOT)
    const next = prependOlder(base, {
      epoch: 'e2',
      turns: [turn('from-another-life', -1)],
      hasOlder: true,
    })

    expect(next.needsSnapshot).toBe('epoch_changed')
    expect(next.turns).toEqual(base.turns)
  })

  it('deriveAttention:有待答 = waiting;都答完且最后一轮已结算 = done', () => {
    const empty = emptyAgentWatchTimeline()
    expect(deriveAttention(empty)).toBe('idle')

    const waiting = applySnapshot(empty, SNAPSHOT)
    expect(deriveAttention(waiting)).toBe('waiting')

    const running = applySnapshot(empty, { ...SNAPSHOT, settlements: [] })
    expect(deriveAttention(running)).toBe('running')

    const done = applySnapshot(empty, {
      ...SNAPSHOT,
      settlements: [],
      turns: [turn('a', 1), turn('b', 2, { outcome: { kind: 'done' } })],
    })
    expect(deriveAttention(done)).toBe('done')
  })
})


/**
 * 钉在时间线末尾的那一组:还等着人答、流里又没有它那一行的。
 * owner 2026-09-09 实机:一条**早已作废**的老提问进会话就钉着、关不掉;
 * owner 2026-10-12 实机:答完的卡一直压在后面每条消息下面,刷新后又没了 —— 有了结局的一律不钉,结局在流里那张卡上。
 */
describe('钉在时间线末尾的结算卡', () => {
  const card = (itemId: string, state: Settlement['state']): Settlement => ({
    itemId,
    kind: 'permission',
    title: '要不要放行',
    state,
    optionId: state === 'resolved' ? 'yes' : null,
    resolvedBy: state === 'resolved' ? 'desktop' : null,
    resolvedAt: state === 'pending' ? null : 1,
  })
  const index = (...list: Settlement[]): Record<string, Settlement> =>
    Object.fromEntries(list.map((s) => [s.itemId, s]))

  it('还等着人答、流里没有它那一行(ACP 审批的 requestId、宿主问)→ 钉住', () => {
    // 阳控:证明这条判据没被改成「什么都不钉」。看不见的待审批 = 卡死的会话。
    expect(pinnedSettlements(index(card('live', 'pending')), new Set()).map((s) => s.itemId)).toEqual(['live'])
  })

  it('还等着人答、流里有它那一行 → 不钉,卡画在那一行上', () => {
    expect(pinnedSettlements(index(card('ask', 'pending')), new Set(['ask']))).toEqual([])
  })

  it('刚被别的端答掉、流里没有它那一行 → ❌ 不钉回执(刷新后也不会有,活着时就不该有)', () => {
    expect(pinnedSettlements(index(card('just-answered', 'resolved')), new Set())).toEqual([])
  })

  it('作废的老提问 → ❌ 不钉(owner 09-09 撞见的那一格)', () => {
    expect(pinnedSettlements(index(card('old-question', 'cancelled')), new Set())).toEqual([])
  })
})

// owner 10-15:手机那份时间线里图只有字数,取到的写回条目 —— 就当它本来就带着图,跟时间线一起存、重开不重取。
describe('取到的工具图写回条目', () => {
  const shot = { mimeType: 'image/jpeg', data: '/9j/AAAA' }
  const tool = (id: string, extra: Record<string, unknown> = {}) => ({ kind: 'mcp-tool-call', id, seq: 1, toolCallId: id, title: 'app_check', status: 'done', imageRefs: [{ mimeType: 'image/jpeg', chars: 8 }, { mimeType: 'image/jpeg', chars: 8 }], ...extra })
  const state = () => ({
    ...emptyAgentWatchTimeline(),
    turns: [
      turn('t1', 1, { items: [tool('a')] as unknown as TranscriptTurn['items'] }),
      turn('t2', 2, { items: [tool('g', { kind: 'tool-group', children: [tool('child')] })] as unknown as TranscriptTurn['items'] }),
    ],
  })

  it('写进那一条的第几张;别的轮原样(同一个引用)', () => {
    const before = state()
    const after = withToolImage(before, 'a', 1, shot)
    const item = after.turns[0]!.items[0] as unknown as { images: unknown[]; imageRefs: unknown[] }
    expect(item.images[1]).toEqual(shot)
    expect(item.images[0]).toBeUndefined()
    expect(item.imageRefs).toHaveLength(2)
    expect(after.turns[1]).toBe(before.turns[1])
  })

  it('工具组里的子调用也认;条目已经不在了就原样返回', () => {
    const after = withToolImage(state(), 'child', 0, shot)
    const child = (after.turns[1]!.items[0] as unknown as { children: { images: unknown[] }[] }).children[0]!
    expect(child.images[0]).toEqual(shot)
    const before = state()
    expect(withToolImage(before, 'gone', 0, shot)).toBe(before)
  })

})

// 复核 47b50d577 要改 1:取到的图写回条目以后,宿主一重发这条条目(读图那一组每多读一张、子代理下的调用一变、
// 换代后的整份快照),按 id 整条替换就把图冲掉了 —— 格子又空着、要再取一遍。合并时把同一组图带过去。
describe('宿主重发条目时,取到的图带过去', () => {
  const shot = { mimeType: 'image/png', data: 'iVBORw0KGgo' }
  const read = (id: string, extra: Record<string, unknown> = {}) => ({ kind: 'mcp-tool-call', id, seq: 1, toolCallId: id, title: 'Read', status: 'done', imageRefs: [{ mimeType: 'image/png', chars: 11 }], ...extra })
  const turnWith = (items: unknown[]) => turn('t1', 1, { items: items as TranscriptTurn['items'] })
  /** 手里:读了一张截图、取到了它。 */
  const held = () => withToolImage(applySnapshot(emptyAgentWatchTimeline(), { cursor: { epoch: 'e1', seq: 10 }, turns: [turnWith([read('r1')])], settlements: [], hasOlder: false }), 'r1', 0, shot)
  const resend = (items: unknown[]): TimelineBatch => ({ from: 10, cursor: { epoch: 'e1', seq: 11 }, turns: [asPatch(turnWith(items))], removedTurnIds: [], settlements: [] })
  const imagesOf = (state: ReturnType<typeof emptyAgentWatchTimeline>, path: number[]) => {
    let node = state.turns[0]!.items[path[0]!] as unknown as { images?: unknown[]; children?: unknown[] }
    for (const i of path.slice(1)) node = node.children![i] as typeof node
    return node.images
  }

  it('增量里这条又来了(只有 refs、内容变了):图还在;同一批应用两次 = 一次', () => {
    const batch = resend([read('r1', { outputText: 'changed' })])
    const once = applyBatch(held(), batch)
    expect(imagesOf(once, [0])).toEqual([shot])
    expect(applyBatch(once, batch)).toEqual(once)
  })

  it('连读第二张:第一张从顶层挪进新建的那一组,图跟着它走', () => {
    const next = applyBatch(held(), resend([{ kind: 'tool-group', id: 'g1', seq: 1, label: 'Read 2', groupKind: 'read-batch', status: 'done', children: [read('r1'), read('r2')] }]))
    expect(imagesOf(next, [0, 0])).toEqual([shot])
    expect(imagesOf(next, [0, 1])).toBeUndefined()
  })

  it('换代推来一份整的快照:图还在', () => {
    const next = applyTimelineResult(held(), { ok: false, reset: 'epoch_changed', snapshot: { cursor: { epoch: 'e2', seq: 1 }, turns: [turnWith([read('r1')])], settlements: [], hasOlder: false } })
    expect(next.lastReset).toBe('epoch_changed')
    expect(imagesOf(next, [0])).toEqual([shot])
  })

  it('refs 不一样了(不是同一组图)就不带,让那一格重新取', () => {
    const next = applyBatch(held(), resend([read('r1', { imageRefs: [{ mimeType: 'image/png', chars: 12 }] })]))
    expect(imagesOf(next, [0])).toBeUndefined()
  })
})
