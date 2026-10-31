// #6927 —— codex agent 的投递时机读成 null:一批里的几条消息各投一次,而不是像 claude 那样合成一条。
//
// 形状:读者按 `deliveryTimingForAgent` 决定一批要不要合并(agentInboxReader injectBatch,只有
// `next-tool-call` 才合)。它从前拿 `liveSessionIdByAgent`(产品 conversation)直接去问
// `sessionProviderSurface`,而 codex 的 `sessionProviderSurface` 按 threadId 键 —— 恒为 null。注入口走的是
// conversation → `deliveryKeyForSession`(codex 报 threadId)→ `sessionProviderSurface`,那条路一直是对的。
// 产品面实测(2026-10-05):codex 一批 rows 3 / units 3,
// claude rows 3 / units 1。
//
// 可证伪:把 `deliveryTimingForAgent` 改回「拿 liveSessionIdByAgent 去查」,第一条转红(null)。
// 第二条:thread 还没建出来时与注入口同口径(不 live ⇒ 没有时机档)。第三条是对照:conversation 键控的
// 属主(claude / opencode / droid / local-session 的形状)照旧查得到。
import { afterEach, describe, expect, it } from 'vitest'
import {
  CodexAppServerRegistry,
  CodexAppServerSession,
} from '../../../../apps/desktop/electron/sessionpage/codex-app-server-delivery'
import {
  SessionpageLocalDeliveryRouter,
  sessionInjectionCapabilityFor,
  type SessionpageDeliveryTarget,
} from '../../../../apps/desktop/electron/sessionpage/session-injection'
import {
  localSessionDeliveryTarget,
  unregisterLocalSessionDeliveryForAgent,
} from '../../../../apps/desktop/electron/sessionpage/local-session-delivery'
import { promoteSessionpageDeliveryOwner } from '../../../../apps/desktop/electron/sessionpage/sessionpage-delivery-owner-registry'

const AGENT = 'agent-6927'
const SESSION = 'conv-6927'
const THREAD_ID = 'tid-6927'

/** 与 codex-pty-provisioning 交给 registry 的那条会话同形:app-server 活着,TUI 还没建 thread(同 #6531 的夹具)。 */
function awaitingTuiSession() {
  const rpc = async (method: string) => {
    if (method === 'thread/resume' || method === 'thread/read') return { thread: { id: THREAD_ID, turns: [], model: 'glm-5.3' } }
    return {}
  }
  const session = new CodexAppServerSession(AGENT, '/unused/codex', undefined, { sessionId: SESSION })
  Object.assign(session as unknown as Record<string, unknown>, {
    client: { rpc },
    awaitingTuiThread: true,
    liveAwaitsAttach: true,
    cwd: '/w',
    endpoint: { kind: 'unix', address: 'unix:///tmp/6927.sock', socketPath: '/tmp/6927.sock' },
    proc: { exitCode: null, signalCode: null },
  })
  const tuiCreatesThread = () => (session as unknown as { adoptTuiThread(m: unknown): boolean })
    .adoptTuiThread({ method: 'thread/started', params: { thread: { id: THREAD_ID } } })
  return { session, tuiCreatesThread }
}

describe('投递时机按注入用的那把钥匙查(#6927)', () => {
  afterEach(() => unregisterLocalSessionDeliveryForAgent(AGENT))

  it('codex:thread 接入后,时机是它声明的 next-tool-call(❌ null ⇒ 一批几条各投一次)', async () => {
    const registry = new CodexAppServerRegistry()
    const router = new SessionpageLocalDeliveryRouter([localSessionDeliveryTarget, registry])
    const { session, tuiCreatesThread } = awaitingTuiSession()
    promoteSessionpageDeliveryOwner(AGENT, () => registry.register(AGENT, session, 'codex'))
    expect(tuiCreatesThread()).toBe(true)
    await session.waitForTuiThread()

    // 两把钥匙确实不同:agent → conversation,conversation → threadId。
    expect(registry.liveSessionIdByAgent(AGENT)).toBe(SESSION)
    expect(registry.deliveryKeyForSession(SESSION)).toBe(THREAD_ID)
    expect(sessionInjectionCapabilityFor('codex', 'tui').timing).toBe('next-tool-call')
    await expect(router.deliveryTimingForAgent(AGENT)).resolves.toBe('next-tool-call')
  })

  it('codex:TUI 还没建出 thread → 没有时机档(与注入口的 not-live 同口径)', async () => {
    const registry = new CodexAppServerRegistry()
    const router = new SessionpageLocalDeliveryRouter([localSessionDeliveryTarget, registry])
    const { session } = awaitingTuiSession()
    promoteSessionpageDeliveryOwner(AGENT, () => registry.register(AGENT, session, 'codex'))

    expect(router.sessionIdForAgent(AGENT)).toBe(SESSION)
    await expect(router.deliveryTimingForAgent(AGENT)).resolves.toBeNull()
    await expect(router.injectForAgent(AGENT, { id: 'msg-6927', text: 'hello' })).resolves.toBe('not-live')
  })

  it('conversation 键控的属主(claude 的形状)照旧查得到(对照)', async () => {
    const sessionKeyed: SessionpageDeliveryTarget = {
      liveSessionIdByAgent: (agentUserId) => (agentUserId === AGENT ? SESSION : null),
      deliveryKeyForSession: (sessionId) => (sessionId === SESSION ? SESSION : null),
      sessionProviderSurface: (key) => (key === SESSION ? { providerId: 'claude', surface: 'tui' } : null),
      tryInjectSessionMessage: async () => true,
    }
    const router = new SessionpageLocalDeliveryRouter([sessionKeyed])
    await expect(router.deliveryTimingForAgent(AGENT))
      .resolves.toBe(sessionInjectionCapabilityFor('claude', 'tui').timing)
  })
})
