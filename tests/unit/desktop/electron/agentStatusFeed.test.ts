import { describe, expect, it, vi } from 'vitest'

import { updateAgent } from '@gugu/core'
import type { AgentStatusReading } from '@gugu/core/shared/agentStatus'
import type { AgentStatusChange, SessionScope } from '@shared/core/sessions/sessionEvents'
import {
  SessionpageLocalDeliveryRouter,
  createSessionpageDeliveryBridge,
  type SessionpageDeliveryTarget,
} from '../../../../apps/desktop/electron/sessionpage/session-injection'
import { AgentStatusFeed } from '../../../../apps/desktop/electron/sessionpage/agent-status-feed'
import {
  SESSION_CACHE_KEY,
  emitSessionpageAgentProvisioned,
} from '../../../../apps/desktop/electron/sessionpage/emdash-agent-provisioning'
import { createTestLocalAgent, isolatedGuguEnv } from '../../../support/deviceRuntimeHarness'

// 身份解析要真读一次本机 roster 文件(异步 I/O)。包一层不替换:查询照旧是真的,只把每一次查询交出来,
// 让用例等「这些查询都已落定」这个事实,❌ 固定轮询一段墙钟时间当作「静止了」。
const rosterLookups = vi.hoisted(() => [] as Array<Promise<unknown>>)
vi.mock('../../../../apps/desktop/electron/sessionpage/sessionpage-session-agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../apps/desktop/electron/sessionpage/sessionpage-session-agent')>()
  return {
    ...actual,
    guguAgentUserIdForSession: (...args: Parameters<typeof actual.guguAgentUserIdForSession>) => {
      const lookup = actual.guguAgentUserIdForSession(...args)
      rosterLookups.push(lookup)
      return lookup
    },
  }
})
const snapshotReads: Array<Promise<unknown>> = []

const SESSION_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_SESSION_ID = '99999999-9999-4999-8999-999999999999'
const AGENT_ID = '22222222-2222-4222-8222-222222222222'

// spec agent-status-writer「宿主按 agent 的流」—— 一个 agent 的状态 = 花名册把它绑在哪条会话上,那条会话的读数,
// 原样。读数只有一个来源:状态写入者的输出。(#4008 的形状:群里 @ 一个 agent,会话页显示它在工作,群聊里却
// 一直空闲 —— 从「有没有一条投递命令正在执行」反推的口径必然答错这里的每一格。)

const reading = (status: AgentStatusReading['status'], detail: AgentStatusReading['detail'] = null): AgentStatusReading => ({
  status,
  detail,
  running: status === 'working' && detail !== 'parked',
  background: detail === 'parked' ? 'running' : null,
})

const change = (sessionId: string, r: AgentStatusReading | null, unseen = false): AgentStatusChange => ({
  sessionId,
  projectId: 'project-1',
  reading: r,
  unseen,
  reviewGate: null,
  providerBlocker: null,
  statusSourceFault: null,
})

function writerSource() {
  const listeners = new Set<(change: AgentStatusChange) => void>()
  const gone = new Set<(scope: SessionScope) => void>()
  const snapshot: AgentStatusChange[] = []
  return {
    snapshot,
    emit(c: AgentStatusChange) {
      for (const listener of listeners) listener(c)
    },
    goneOf(scope: SessionScope) {
      for (const listener of gone) listener(scope)
    },
    source: {
      onAgentStatus: (cb: (c: AgentStatusChange) => void) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      },
      agentStatusSnapshot: () => {
        const read = Promise.resolve(snapshot)
        snapshotReads.push(read)
        return read
      },
      onSessionsGone: (cb: (scope: SessionScope) => void) => {
        gone.add(cb)
        return () => gone.delete(cb)
      },
    },
  }
}

// 等到此刻为止发出的快照读与 roster 查询都已落定。feed 在拿到它们的那一刻就挂上了后续(查到身份 → 绑定 → 宣告,
// 同步完成),这里的 await 排在那些后续之后 —— 等到它,feed 对这些读数该做的都已做完。
// 快照读先等:feed 读到快照才去查身份,查询在那之后才出现。
async function settle(): Promise<void> {
  await Promise.allSettled(snapshotReads.splice(0))
  await Promise.allSettled(rosterLookups.splice(0))
}

async function bindAgent(env: NodeJS.ProcessEnv, sessionId = SESSION_ID) {
  await createTestLocalAgent(
    env,
    { gugu_user_id: AGENT_ID },
    { cache: { [SESSION_CACHE_KEY]: sessionId }, status: 'active' },
  )
}

describe('宿主按 agent 的流:agent 的状态 = 它绑的那条会话的读数', () => {
  it('写入者说什么,这个 agent 就是什么 —— 包括在跑、等你、后台在跑、做完', async () => {
    const env = await isolatedGuguEnv('gugu-agent-status-feed-')
    await bindAgent(env)
    const feed = new AgentStatusFeed()
    const writer = writerSource()
    feed.attach(writer.source, { env })
    expect(feed.get(AGENT_ID), '还没有任何读数时不许自称什么').toBeNull()

    for (const r of [reading('working', 'running'), reading('needs_user', 'approval'), reading('working', 'parked'), reading('idle', 'done')]) {
      writer.emit(change(SESSION_ID, r))
      await settle()
      expect(feed.get(AGENT_ID)?.reading).toEqual(r)
    }
    feed.dispose()
  })

  it('读数变了才宣告,带单调的版本;同一句话重复到达不打扰', async () => {
    const env = await isolatedGuguEnv('gugu-agent-status-feed-')
    await bindAgent(env)
    const feed = new AgentStatusFeed()
    const writer = writerSource()
    const heard: Array<[string, string | null, number]> = []
    feed.attach(writer.source, { env })
    feed.subscribe((agentUserId, entry, _previous, version) => heard.push([agentUserId, entry?.reading?.status ?? null, version]))

    writer.emit(change(SESSION_ID, reading('working', 'running')))
    await settle()
    writer.emit(change(SESSION_ID, reading('working', 'running')))
    await settle()
    writer.emit(change(SESSION_ID, reading('idle', 'done'), true))
    await settle()

    expect(heard.map(([id, status]) => [id, status])).toEqual([
      [AGENT_ID, 'working'],
      [AGENT_ID, 'idle'],
    ])
    expect(heard[1]![2]).toBeGreaterThan(heard[0]![2])
    expect(feed.snapshot().version).toBe(heard[1]![2])
    feed.dispose()
  })

  it('启动快照就能说出它此刻的读数 —— 不必等下一次写入', async () => {
    const env = await isolatedGuguEnv('gugu-agent-status-feed-')
    await bindAgent(env)
    const feed = new AgentStatusFeed()
    const writer = writerSource()
    writer.snapshot.push(change(SESSION_ID, reading('working', 'running')))
    feed.attach(writer.source, { env })
    await settle()
    expect(feed.get(AGENT_ID)?.reading?.status).toBe('working')
    feed.dispose()
  })

  it('还没 provision 身份的会话不点亮任何人;身份铸出后按已记下的读数补上(#4641)', async () => {
    const env = await isolatedGuguEnv('gugu-agent-status-feed-race-')
    const feed = new AgentStatusFeed()
    const writer = writerSource()
    feed.attach(writer.source, { env })
    writer.emit(change(SESSION_ID, reading('working', 'running')))
    await settle()
    expect(feed.get(AGENT_ID)).toBeNull()

    await bindAgent(env)
    emitSessionpageAgentProvisioned({ sessionId: SESSION_ID, agentUserId: AGENT_ID, displayName: 'Codex 1', chatId: null })
    await settle()
    expect(feed.get(AGENT_ID)?.reading?.status, '身份铸出后必须重算早到的读数').toBe('working')
    feed.dispose()
  })

  it('花名册把它绑到另一条会话:旧会话的读数不再代表它(❌ 多会话按优先级折叠)', async () => {
    const env = await isolatedGuguEnv('gugu-agent-status-feed-rebind-')
    await bindAgent(env)
    const feed = new AgentStatusFeed()
    const writer = writerSource()
    feed.attach(writer.source, { env })
    writer.emit(change(SESSION_ID, reading('needs_user', 'approval')))
    await settle()
    expect(feed.get(AGENT_ID)?.sessionId).toBe(SESSION_ID)

    // 重绑 = provisioning 先把花名册改到新会话,再宣告。
    await updateAgent({ guguUserId: AGENT_ID }, { cache: { [SESSION_CACHE_KEY]: OTHER_SESSION_ID } }, env)
    emitSessionpageAgentProvisioned({ sessionId: OTHER_SESSION_ID, agentUserId: AGENT_ID, displayName: 'Codex 1', chatId: null })
    writer.emit(change(OTHER_SESSION_ID, reading('idle', 'plain')))
    await settle()
    expect(feed.get(AGENT_ID)?.sessionId).toBe(OTHER_SESSION_ID)
    expect(feed.get(AGENT_ID)?.reading?.status).toBe('idle')

    writer.emit(change(SESSION_ID, reading('working', 'running')))
    await settle()
    expect(feed.get(AGENT_ID)?.reading?.status, '不再绑着的会话说什么都不算').toBe('idle')
    feed.dispose()
  })

  it('会话不在了(删除 / 归档):它的 agent 从流里消失', async () => {
    const env = await isolatedGuguEnv('gugu-agent-status-feed-gone-')
    await bindAgent(env)
    const feed = new AgentStatusFeed()
    const writer = writerSource()
    const heard: Array<string | null> = []
    feed.attach(writer.source, { env })
    feed.subscribe((_agentUserId, entry) => heard.push(entry?.reading?.status ?? null))
    writer.emit(change(SESSION_ID, reading('working', 'running')))
    await settle()
    writer.goneOf({ sessionId: SESSION_ID })
    expect(feed.get(AGENT_ID)).toBeNull()
    expect(heard).toEqual(['working', null])
    feed.dispose()
  })

  it('投递桥与设备 runtime 读的就是它:没有任何 transport 自报在飞,读数在跑就是在跑;变了就宣告', async () => {
    const env = await isolatedGuguEnv('gugu-agent-status-feed-bridge-')
    await bindAgent(env)
    const feed = new AgentStatusFeed()
    const writer = writerSource()
    feed.attach(writer.source, { env })

    // 这正是 claude rendezvous / codex deferred / 用户在会话页自己敲的那些情形:投递早就返回了(或压根不存在),
    // 而引擎还在跑。反推口径在这里必然答错。
    const target: SessionpageDeliveryTarget = {
      deliveryTargetName: 'no-turn-tracking',
      liveSessionIdByAgent: (agentUserId) => (agentUserId === AGENT_ID ? SESSION_ID : null),
      sessionProviderSurface: () => null,
      tryInjectSessionMessage: vi.fn(async () => false),
    }
    const bridge = createSessionpageDeliveryBridge(new SessionpageLocalDeliveryRouter([target]), { agentStatus: feed })

    expect(bridge.agentStatus?.(AGENT_ID)).toBeNull()
    const woken = vi.fn()
    const off = bridge.onAgentStatusChanged?.(woken)
    writer.emit(change(SESSION_ID, reading('working', 'running')))
    await settle()
    expect(bridge.agentStatus?.(AGENT_ID)?.status, '任务页在跑 = 它在跑').toBe('working')
    expect(woken, '读数一变就叫醒宿主,不等下一格节律').toHaveBeenCalledWith(AGENT_ID)
    off?.()
    feed.dispose()
  })
})
