// @vitest-environment jsdom
//
// 宿主按 agent 的流在渲染层的属主。判的是三件事:
//   ① 属主是 app 级单例,不是视图 —— 它的寿命长于它写下的事实;
//   ② 每一条按 **agentId** 写进那张唯一的表;先后只看宿主的版本,快照与变化谁先到结果都一样;
//   ③ 缺版本 / 形状不对 = 协议被破坏,响亮地停(❌ 猜成某个状态)。
import { beforeEach, describe, expect, it, vi } from 'vitest'

const events = new Map<string, Array<(data: unknown) => void>>()
let snapshot: unknown = { entries: [], version: 0 }
/** 设了就用它回答快照请求(让快照「还在路上」)。 */
let pendingSnapshot: Promise<unknown> | null = null

;(window as unknown as { electronAPI: unknown }).electronAPI = {
  invoke: () => pendingSnapshot ?? Promise.resolve(snapshot),
  eventOn: (channel: string, cb: (data: unknown) => void) => {
    const list = events.get(channel) ?? []
    list.push(cb)
    events.set(channel, list)
    return () => {}
  },
}

const written: Array<[string, string | null]> = []
vi.mock('@/lib/agentPresenceStore', () => ({
  setLocalAgentStatus: (agentUserId: string, local: { reading: { status: string } | null } | null) => {
    written.push([agentUserId, local ? local.reading?.status ?? 'no-source' : null])
  },
}))

const {
  AGENT_STATUS_FEED_EVENT,
  installAgentStatusFeedBridge,
  resetAgentStatusFeedBridgeForTest,
} = await import('@/lib/agentStatusFeedBridge')

const entry = (agentUserId: string, status: string | null) => ({
  agentUserId,
  sessionId: `conversation-${agentUserId}`,
  projectId: 'project-1',
  reading: status ? { status, detail: null, running: status === 'working', background: null } : null,
  unseen: false,
  reviewGate: null,
  providerBlocker: null,
})
const emit = (payload: unknown) => {
  for (const cb of events.get(AGENT_STATUS_FEED_EVENT) ?? []) cb(payload)
}
const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

beforeEach(() => {
  written.length = 0
  events.clear()
  snapshot = { entries: [], version: 0 }
  pendingSnapshot = null
  resetAgentStatusFeedBridgeForTest()
})

describe('agentStatusFeedBridge', () => {
  it('writes every change by agentId, in host version order', async () => {
    installAgentStatusFeedBridge()
    await flush()
    emit({ agentUserId: 'agent-a', entry: entry('agent-a', 'working'), version: 2 })
    emit({ agentUserId: 'agent-a', entry: entry('agent-a', 'idle'), version: 3 })
    // 乱序到达的旧话对已知的没有话可说。
    emit({ agentUserId: 'agent-a', entry: entry('agent-a', 'working'), version: 1 })
    emit({ agentUserId: 'agent-a', entry: null, version: 4 })
    expect(written).toEqual([
      ['agent-a', 'working'],
      ['agent-a', 'idle'],
      ['agent-a', null],
    ])
  })

  it('a snapshot older than a change already applied does not overwrite it; agents missing from a newer snapshot are cleared', async () => {
    let answer: (value: unknown) => void = () => {}
    pendingSnapshot = new Promise((resolve) => { answer = resolve })
    installAgentStatusFeedBridge()
    // 快照在路上时来了一条更新的变化。
    emit({ agentUserId: 'agent-a', entry: entry('agent-a', 'needs_user'), version: 7 })
    emit({ agentUserId: 'agent-b', entry: entry('agent-b', 'working'), version: 3 })
    answer({ entries: [entry('agent-a', 'working')], version: 5 })
    await flush()
    expect(written).toEqual([
      ['agent-a', 'needs_user'],
      ['agent-b', 'working'],
      // agent-b 不在版本 5 的快照里:它在版本 3 之后离开了这台机器。
      ['agent-b', null],
    ])
  })

  it('a conversation without a status source is a local entry with no reading, not a missing agent', async () => {
    snapshot = { entries: [entry('agent-a', null)], version: 1 }
    installAgentStatusFeedBridge()
    await flush()
    expect(written).toEqual([['agent-a', 'no-source']])
  })

  it('is an app-level singleton: a second install does not subscribe twice', async () => {
    installAgentStatusFeedBridge()
    installAgentStatusFeedBridge()
    await flush()
    expect(events.get(AGENT_STATUS_FEED_EVENT)).toHaveLength(1)
  })

  it('fails loudly on a change without a host version or with a malformed entry', async () => {
    installAgentStatusFeedBridge()
    await flush()
    expect(() => emit({ agentUserId: 'agent-a', entry: entry('agent-a', 'working') })).toThrow('host version')
    expect(() => emit({ agentUserId: 'agent-a', entry: { ...entry('agent-a', 'working'), unseen: 'no' }, version: 9 }))
      .toThrow('unseen')
    expect(() => emit({ agentUserId: 'agent-a', entry: entry('agent-a', 'online'), version: 9 })).toThrow('unknown agent status')
    expect(written).toEqual([])
  })
})
