import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionpageSessionsEvent, SessionpageSessionsListResult } from '@gugu/session-core/session-record/contract'
import {
  sessionListFromDigest,
  startSessionListSync,
  type SessionpageSessionListClient,
} from '../../../apps/desktop/src/session/shared/remote-sessions/session-list-sync'
import { normalizeSessionDigest } from '@gugu/core/cloud/devices'

function list(title: string): SessionpageSessionsListResult {
  return {
    projects: [{ id: 'p1', name: 'repo', path: '/home/bob/repo' }],
    sessions: [{
      conversationId: 'c1', projectId: 'p1', title, harness: 'codex', runtime: 'acp',
      agentStatus: 'working', lastInteractedAt: null, supported: true,
    }],
  }
}

/** A fake host: a subscription answers ok, then pushes the whole list as its first frame (as the host does, protocol 8). */
function fakeClient() {
  const pushes = new Map<string, (event: SessionpageSessionsEvent) => void>()
  const links = new Set<(open: boolean) => void>()
  let current = list('first')
  const client: SessionpageSessionListClient = {
    subscribeSessionsList: vi.fn(async (_d: string, sub: string) => {
      const whole = current
      queueMicrotask(() => pushes.get(sub)?.({ subscriptionId: sub, full: whole }))
      return {}
    }),
    unsubscribeSessionsList: vi.fn(async () => ({})),
    subscribeSessionsListEvents: vi.fn((_d, sub, onEvent) => {
      pushes.set(sub, onEvent)
      return () => pushes.delete(sub)
    }),
    onLinkChange: vi.fn((_d, cb) => {
      links.add(cb)
      return () => links.delete(cb)
    }),
  }
  return {
    client,
    pushes,
    links,
    setCurrent: (next: SessionpageSessionsListResult) => { current = next },
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('startSessionListSync(#6264 手机与桌面任务页共用的会话列表同步)', () => {
  afterEach(() => vi.restoreAllMocks())

  it('订阅、看着窗口;订上那一刻的整份是底,之后的增量合上去', async () => {
    const f = fakeClient()
    const seen: string[] = []
    const lists: SessionpageSessionsListResult[] = []
    const sync = startSessionListSync(f.client, 'dev-1', {
      onList: (r) => { seen.push(r.sessions[0]!.title); lists.push(r) },
    })
    await flush()
    expect(seen).toEqual(['first'])
    expect(f.client.subscribeSessionsList).toHaveBeenCalledTimes(1)
    expect(f.links.size).toBe(1)
    const [[sub, push]] = [...f.pushes.entries()]
    const renamed = { ...list('pushed').sessions[0]! }
    const added = { ...renamed, conversationId: 'c2', title: 'second' }
    push!({ subscriptionId: sub!, changed: [renamed, added], removed: [] })
    expect(lists.at(-1)!.sessions.map((s) => [s.conversationId, s.title])).toEqual([['c1', 'pushed'], ['c2', 'second']])
    push!({ subscriptionId: sub!, changed: [], removed: ['c1'] })
    expect(lists.at(-1)!.sessions.map((s) => s.conversationId)).toEqual(['c2'])
    expect(lists.at(-1)!.projects).toEqual(list('x').projects)
    sync.stop()
    expect(f.client.unsubscribeSessionsList).toHaveBeenCalledTimes(1)
    expect(f.links.size).toBe(0)
  })

  it('窗口断过再通(那台机器随旧窗口拆了订阅;丢了推送也走这里):整个重来 —— 新订阅号、新的整份', async () => {
    const f = fakeClient()
    const seen: string[] = []
    startSessionListSync(f.client, 'dev-1', { onList: (r) => { seen.push(r.sessions[0]!.title) } })
    await flush()
    f.setCurrent(list('after-reopen'))
    for (const cb of f.links) cb(false)
    await flush()
    expect(f.client.subscribeSessionsList).toHaveBeenCalledTimes(1)
    for (const cb of f.links) cb(true)
    await flush()
    expect(f.client.subscribeSessionsList).toHaveBeenCalledTimes(2)
    const subs = vi.mocked(f.client.subscribeSessionsList).mock.calls.map((c) => c[1])
    expect(subs[0]).not.toBe(subs[1])
    expect(seen.at(-1)).toBe('after-reopen')
  })

  it('reports a transport close immediately without waiting for a heartbeat or another list', async () => {
    const f = fakeClient()
    const connection = vi.fn()
    const sync = startSessionListSync(f.client, 'dev-1', { onList: () => {}, onLink: connection })
    await flush()
    for (const cb of f.links) cb(false)
    expect(connection).toHaveBeenLastCalledWith(false)
    expect(f.client.subscribeSessionsList).toHaveBeenCalledTimes(1)
    sync.stop()
  })

  it('被重连之后,旧那一轮的推送一帧都不收(❌ 拿旧订阅的帧盖新的那份)', async () => {
    const f = fakeClient()
    const seen: string[] = []
    const sync = startSessionListSync(f.client, 'dev-1', { onList: (r) => { seen.push(r.sessions[0]!.title) } })
    await flush()
    const [[oldSub, oldPush]] = [...f.pushes.entries()]
    sync.reconnect()
    await flush()
    oldPush!({ subscriptionId: oldSub!, full: list('stale') })
    expect(seen).toEqual(['first', 'first'])
    expect(vi.mocked(f.client.unsubscribeSessionsList).mock.calls.map((c) => c[1])).toEqual([oldSub])
    sync.stop()
  })

  it('整份之前来了增量 = 约定破了:报错,和别的失败一样等退避再换新订阅号重来(❌ 立刻连着重订)', async () => {
    vi.useFakeTimers()
    try {
      const f = fakeClient()
      vi.mocked(f.client.subscribeSessionsList).mockImplementationOnce(async (_d, sub) => {
        queueMicrotask(() => f.pushes.get(sub)?.({ subscriptionId: sub, changed: [], removed: ['c1'] }))
        return {}
      })
      const errors: Array<string | null> = []
      const seen: string[] = []
      const sync = startSessionListSync(f.client, 'dev-1', { onList: (r) => { seen.push(r.sessions[0]!.title) }, onError: (m) => errors.push(m) })
      await vi.advanceTimersByTimeAsync(0)
      expect(errors).toContain(`session list subscription ${vi.mocked(f.client.subscribeSessionsList).mock.calls[0]![1]}: a change arrived before the full list`)
      await vi.advanceTimersByTimeAsync(4_000)
      expect(f.client.subscribeSessionsList, 'no immediate re-subscribe').toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(f.client.subscribeSessionsList, 'after the back-off').toHaveBeenCalledTimes(2)
      expect(seen).toEqual(['first'])
      sync.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('订阅失败:如实报错,❌ 吞掉', async () => {
    const f = fakeClient()
    vi.mocked(f.client.subscribeSessionsList).mockRejectedValueOnce(new Error('device offline'))
    const errors: Array<string | null> = []
    startSessionListSync(f.client, 'dev-1', { onList: () => undefined, onError: (m) => errors.push(m) })
    await flush()
    expect(errors.at(-1)).toBe('device offline')
  })
})

describe('startSessionListSync:列不出来时自己再试(#6264 断线重连)', () => {
  afterEach(() => vi.useRealTimers())

  it('传输层失败:按 5 秒退避再订', async () => {
    vi.useFakeTimers()
    const f = fakeClient()
    vi.mocked(f.client.subscribeSessionsList).mockRejectedValueOnce(new Error('timeout'))
    const sync = startSessionListSync(f.client, 'dev-1', { onList: () => undefined })
    await vi.advanceTimersByTimeAsync(4_999)
    expect(f.client.subscribeSessionsList).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(f.client.subscribeSessionsList).toHaveBeenCalledTimes(2)
    sync.stop()
  })

  // 冷启动实撞:第一条列表随一次失败的开线落空,窗口 1 s 后就通了,列表却要等满 5 s 的退避。
  it('列失败以后窗口一通就重来,退避作废;窗口一直不通,退避照旧、不狂发', async () => {
    vi.useFakeTimers()
    const f = fakeClient()
    vi.mocked(f.client.subscribeSessionsList).mockRejectedValueOnce(new Error('host unreachable'))
    const sync = startSessionListSync(f.client, 'dev-1', { onList: () => undefined })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(f.client.subscribeSessionsList).toHaveBeenCalledTimes(1)
    for (const cb of f.links) cb(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.client.subscribeSessionsList, 'the window is open: list again now').toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(f.client.subscribeSessionsList, 'the cancelled back-off does not fire a third list').toHaveBeenCalledTimes(2)
    sync.stop()

    // 窗口一直连不上:没有接通事件,只按退避再试。
    const g = fakeClient()
    vi.mocked(g.client.subscribeSessionsList).mockRejectedValue(new Error('host unreachable'))
    const stuck = startSessionListSync(g.client, 'dev-1', { onList: () => undefined })
    // 0 s 第一次;5 s、10 s 各一次;下一次在 20 s(5、5、10…30 s 的节奏)。
    await vi.advanceTimersByTimeAsync(19_000)
    expect(g.client.subscribeSessionsList).toHaveBeenCalledTimes(3)
    stuck.stop()
  })

  it('那台机器不认这个接口(太旧):不重试;「重新连接」立刻再来一遍', async () => {
    vi.useFakeTimers()
    const f = fakeClient()
    vi.mocked(f.client.subscribeSessionsList).mockRejectedValueOnce(Object.assign(new Error('unknown'), { code: 'server_outdated' }))
    const sync = startSessionListSync(f.client, 'dev-1', { onList: () => undefined })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.client.subscribeSessionsList).toHaveBeenCalledTimes(1)
    sync.reconnect()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.client.subscribeSessionsList).toHaveBeenCalledTimes(2)
    sync.stop()
  })

  it('停掉之后不再重试', async () => {
    vi.useFakeTimers()
    const f = fakeClient()
    vi.mocked(f.client.subscribeSessionsList).mockRejectedValueOnce(new Error('timeout'))
    const sync = startSessionListSync(f.client, 'dev-1', { onList: () => undefined })
    await vi.advanceTimersByTimeAsync(0)
    sync.stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.client.subscribeSessionsList).toHaveBeenCalledTimes(1)
  })
})

describe('sessionListFromDigest(没读到那台机器此刻的列表时退回心跳摘要)', () => {
  it('项目照样列出;每条会话都打不开;老宿主没报的字段不补默认值', () => {
    const result = sessionListFromDigest([
      { conversationId: 'c1', projectId: 'p1', projectName: 'repo', title: 't', harness: 'codex', agentStatus: 'done', lastInteractedAt: null, supported: true },
      { conversationId: 'c2', projectId: 'p1', projectName: 'repo', title: 'u', harness: 'claude', agentStatus: null, lastInteractedAt: null, supported: true, isPinned: true },
    ])
    expect(result.projects).toEqual([{ id: 'p1', name: 'repo', path: '' }])
    expect(result.sessions.every((s) => s.supported === false)).toBe(true)
    expect('isPinned' in result.sessions[0]!).toBe(false)
    expect(result.sessions[1]!.isPinned).toBe(true)
  })

  it('#609 摘要里没名字的(任务工作区、workspace)不是项目:会话照列,项目不列 —— 手机把它们列进「任务」,❌ 一格没名字的项目', () => {
    const result = sessionListFromDigest([
      { conversationId: 'c1', projectId: 'tw', projectName: '', title: 't', harness: 'codex', agentStatus: null, lastInteractedAt: null, supported: true },
      { conversationId: 'c2', projectId: 'p1', projectName: 'repo', title: 'u', harness: 'codex', agentStatus: null, lastInteractedAt: null, supported: true },
    ])
    expect(result.projects).toEqual([{ id: 'p1', name: 'repo', path: '' }])
    expect(result.sessions.map((s) => s.projectId)).toEqual(['tw', 'p1'])
  })

  it('机器在线(还在读 / 一时连不上):照宿主自己报的能不能打开', () => {
    const result = sessionListFromDigest([
      { conversationId: 'c1', projectId: 'p1', projectName: 'repo', title: 't', harness: 'codex', agentStatus: null, lastInteractedAt: null, supported: true },
      { conversationId: 'c2', projectId: 'p1', projectName: 'repo', title: 'u', harness: 'codex', agentStatus: null, lastInteractedAt: null, supported: false },
    ], true)
    expect(result.sessions.map((s) => s.supported)).toEqual([true, false])
  })
})

describe('摘要里的 agent(#7199:离线时任务区也认得出个人助理自己那条)', () => {
  const base = { conversationId: 'c', projectId: 'p1', projectName: 'repo', title: 't', harness: 'claude', agentStatus: null, lastInteractedAt: null, supported: true }
  it('retains an advertised native input contract through normalization and an offline cold directory', () => {
    const rows = normalizeSessionDigest([{ ...base, nativeInputVersion: 1, runtime: 'acp', agentUserId: 'mine' }, { ...base, conversationId: 'files', nativeInputVersion: 2 }, { ...base, conversationId: 'old', nativeInputVersion: 3, runtime: 'bogus' }])
    const sessions = sessionListFromDigest(rows, false).sessions
    expect(sessions[0]).toMatchObject({ nativeInputVersion: 1, runtime: 'acp', agent: { userId: 'mine' } })
    expect(sessions[1]).toMatchObject({ nativeInputVersion: 2 })
    expect(sessions[2]).not.toHaveProperty('nativeInputVersion')
    expect(sessions[2]!.runtime).toBe('unknown')
  })
  it('宿主报了才带:id、null(没有 agent)、缺席(老宿主)三种分开', () => {
    const rows = normalizeSessionDigest([
      { ...base, conversationId: 'a', agentUserId: 'u1' },
      { ...base, conversationId: 'b', agentUserId: null },
      { ...base, conversationId: 'c' },
      { ...base, conversationId: 'd', agentUserId: 42 },
    ])
    expect(rows.map((row) => ('agentUserId' in row ? row.agentUserId : 'absent'))).toEqual(['u1', null, 'absent', 'absent'])
    const sessions = sessionListFromDigest(rows).sessions
    expect(sessions[0]!.agent).toEqual({ userId: 'u1' })
    expect(sessions[1]!.agent).toBeNull()
    expect('agent' in sessions[2]!).toBe(false)
  })
})
