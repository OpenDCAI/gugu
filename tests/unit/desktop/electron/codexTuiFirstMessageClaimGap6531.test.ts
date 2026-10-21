// #6531 —— 聊天页新建 codex·TUI、刚建好就发首句:消息其实送达了,聊天里却冒出一条
// 「Agent 回合执行失败:这批 1 条消息未处理成功」。
//
// 形状:@@@6112 起新会话的 thread 由 TUI 建,`promoteSessionpageDeliveryOwner` 登记 app-server 会话时
// threadId 还是 null,而它在同一回合摘掉了离线占位。codex 认领者从前以 threadId 为准答
// `liveSessionIdByAgent` ⇒ TUI 建出 thread 之前(实测约 1s)本机「无属主」,读者这时拉到首句,注入口
// THROW `has no local session-page runtime` ⇒ 读者先披露失败再抛;随后 thread 接入、session-live 重拉,
// 同一条消息照常送达。
//
// 可证伪:把 `CodexAppServerRegistry.liveSessionIdByAgent` 改回 `threadId ? conversation : null`,
// 前两条转红(第一条 THROW,第二条交接把正在等 TUI 的会话处置掉)。第三条是阳性对照 —— 修法不能是
// 「永远不投」;第四条是阴性对照 —— 本机真没有这个 agent 的 runtime 时照旧 fail loud。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CodexAppServerRegistry,
  CodexAppServerSession,
  codexAppServerRegistry,
} from '../../../../apps/desktop/electron/sessionpage/codex-app-server-delivery'
import { SessionpageLocalDeliveryRouter } from '../../../../apps/desktop/electron/sessionpage/session-injection'
import {
  localSessionDeliveryTarget,
  registerOfflineLocalSessionDelivery,
  unregisterLocalSessionDeliveryForAgent,
} from '../../../../apps/desktop/electron/sessionpage/local-session-delivery'
import {
  prepareSessionpageDeliveryOwner,
  promoteSessionpageDeliveryOwner,
} from '../../../../apps/desktop/electron/sessionpage/sessionpage-delivery-owner-registry'

const AGENT = 'agent-6531'
const SESSION = 'conv-6531'

/** 与 codex-pty-provisioning 在 `tuiLoads: 'create'` 之后交给 registry 的那条会话同形:app-server 活着、TUI 还没建 thread。 */
function awaitingTuiSession() {
  let queued = 0
  const rpc = async (method: string) => {
    if (method === 'thread/resume' || method === 'thread/read') {
      return { thread: { id: 'tid-6531', turns: [], model: 'glm-5.3' } }
    }
    if (method === 'thread/queue/add') return { queuedSubmission: { id: `q-${++queued}` } }
    return {}
  }
  const session = new CodexAppServerSession(AGENT, '/unused/codex', undefined, { sessionId: SESSION })
  Object.assign(session as unknown as Record<string, unknown>, {
    client: { rpc },
    awaitingTuiThread: true,
    liveAwaitsAttach: true,
    cwd: '/w',
    endpoint: { kind: 'unix', address: 'unix:///tmp/6531.sock', socketPath: '/tmp/6531.sock' },
    proc: { exitCode: null, signalCode: null },
  })
  const tuiCreatesThread = () => (session as unknown as { adoptTuiThread(m: unknown): boolean })
    .adoptTuiThread({ method: 'thread/started', params: { thread: { id: 'tid-6531' } } })
  return { session, tuiCreatesThread }
}

describe('codex TUI 新会话:登记即认领,TUI 建出 thread 之前没有无属主窗口(#6531)', () => {
  beforeEach(() => {
    // prepareSessionpageDeliveryOwner('native', …) 在起 app-server 之前留下的离线占位。
    registerOfflineLocalSessionDelivery(AGENT, { sessionId: SESSION, providerId: 'codex' })
  })
  afterEach(() => {
    unregisterLocalSessionDeliveryForAgent(AGENT)
    vi.restoreAllMocks()
  })

  it('promotion 之后、TUI 建出 thread 之前:属主是这条 app-server 会话,首句答 not-live(❌ THROW 进失败披露)', async () => {
    const registry = new CodexAppServerRegistry()
    const router = new SessionpageLocalDeliveryRouter([localSessionDeliveryTarget, registry])
    const { session } = awaitingTuiSession()
    promoteSessionpageDeliveryOwner(AGENT, () => registry.register(AGENT, session, 'codex'))

    expect(localSessionDeliveryTarget.liveSessionIdByAgent(AGENT)).toBeNull()
    expect(router.deliveryTargetFor(AGENT)).toBe(registry)
    expect(router.sessionIdForAgent(AGENT)).toBe(SESSION)
    // 可不可投是另一把钥匙:thread 还不存在,conversation 键控的注入权威查不到会话。
    expect(registry.deliveryKeyForSession(SESSION)).toBeNull()
    await expect(router.injectForAgent(AGENT, { id: 'msg-first', text: 'hello' })).resolves.toBe('not-live')
  })

  it('这个窗口里重入开户(聊天页 ensureAgentAddress)不把正在等 TUI 的会话当旧属主处置掉(#5415 同形)', async () => {
    const { session } = awaitingTuiSession()
    const dispose = vi.spyOn(session, 'dispose').mockResolvedValue(undefined)
    promoteSessionpageDeliveryOwner(AGENT, () => codexAppServerRegistry.register(AGENT, session, 'codex'))
    try {
      await prepareSessionpageDeliveryOwner('native', { guguAgentUserId: AGENT, sessionId: SESSION }, { providerId: 'codex' })
      expect(dispose).not.toHaveBeenCalled()
      expect(codexAppServerRegistry.liveSessionIdByAgent(AGENT)).toBe(SESSION)
      expect(localSessionDeliveryTarget.liveSessionIdByAgent(AGENT)).toBeNull()
    } finally {
      await codexAppServerRegistry.unregister(AGENT)
    }
  })

  it('TUI 建出 thread、咕咕接入完成 → session-live 叫醒读者,同一条消息被接受(阳性对照)', async () => {
    const registry = new CodexAppServerRegistry()
    const router = new SessionpageLocalDeliveryRouter([localSessionDeliveryTarget, registry])
    const live: unknown[] = []
    registry.setLiveHooks({ onLive: (registration) => live.push(registration) })
    const { session, tuiCreatesThread } = awaitingTuiSession()
    promoteSessionpageDeliveryOwner(AGENT, () => registry.register(AGENT, session, 'codex'))

    expect(tuiCreatesThread()).toBe(true)
    await session.waitForTuiThread()
    expect(live).toEqual([{ guguAgentUserId: AGENT, sessionId: SESSION }])
    expect(router.deliveryTargetFor(AGENT)).toBe(registry)
    await expect(router.injectForAgent(AGENT, { id: 'msg-first', text: 'hello' })).resolves.toBe('accepted')
  })

  it('本机确实没有这个 agent 的任何认领者 → 照旧 THROW(读者据此披露失败,fail loud 不变)', async () => {
    unregisterLocalSessionDeliveryForAgent(AGENT)
    const router = new SessionpageLocalDeliveryRouter([localSessionDeliveryTarget, new CodexAppServerRegistry()])
    await expect(router.injectForAgent(AGENT, { id: 'msg-orphan', text: 'hello' }))
      .rejects.toThrow(`Agent ${AGENT} has no local session-page runtime`)
  })
})
