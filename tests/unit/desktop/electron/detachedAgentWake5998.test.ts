import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createLocalSessionDeliveryBridge,
  localSessionDeliveryTarget,
} from '../../../../apps/desktop/electron/sessionpage/local-session-delivery'
import {
  createSessionpageDeliveryBridge,
  SessionWakeError,
  SessionpageLocalDeliveryRouter,
  type SessionpageDeliveryTarget,
} from '../../../../apps/desktop/electron/sessionpage/session-injection'

const AGENT = 'detached-agent-5998'
const SESSION = 'detached-conversation-5998'

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

afterEach(() => {
  const registry = createLocalSessionDeliveryBridge()
  registry.unregisterAgent(AGENT)
})

function detachedOwner() {
  const registry = createLocalSessionDeliveryBridge()
  registry.registerOffline(AGENT, { sessionId: SESSION, providerId: 'codex' })
  return registry
}

describe('#5998 detached inbox wake', () => {
  it('wakes the same persisted conversation once and redelivers after native admission', async () => {
    const registry = detachedOwner()
    const started = deferred()
    const wakeSession = vi.fn(() => started.promise)
    const onWakeComplete = vi.fn()
    const inputs: string[] = []
    let live = false
    const native: SessionpageDeliveryTarget = {
      liveSessionIdByAgent: (id) => live && id === AGENT ? SESSION : null,
      deliveryKeyForSession: (id) => live && id === SESSION ? SESSION : null,
      sessionProviderSurface: () => live ? { providerId: 'codex', surface: 'tui' } : null,
      tryInjectSessionMessage: async (_id, message) => { inputs.push(message.text); return true },
    }
    const router = new SessionpageLocalDeliveryRouter([localSessionDeliveryTarget, native], {
      wakeSession, onWakeComplete,
    })
    // Both production paths (device command and host kick) use the same bridge callback.
    const deviceBridge = createSessionpageDeliveryBridge(router)
    const hostBridge = createSessionpageDeliveryBridge(router)
    const input = { agentUserId: AGENT, messageId: 'mention-1', text: 'resume my previous task' }
    expect(await deviceBridge.injectAgentInbox!(input)).toBe('not-live')
    deviceBridge.wakeAgentSession!(AGENT)
    hostBridge.wakeAgentSession!(AGENT)
    await vi.waitFor(() => expect(wakeSession).toHaveBeenCalledExactlyOnceWith(SESSION))
    expect(inputs).toEqual([])
    expect(onWakeComplete).not.toHaveBeenCalled()

    registry.unregisterAgent(AGENT)
    live = true
    started.resolve()
    await vi.waitFor(() => expect(onWakeComplete).toHaveBeenCalledExactlyOnceWith(AGENT, SESSION))
    expect(await deviceBridge.injectAgentInbox!(input)).toBe('accepted')
    expect(inputs).toEqual([input.text])
    expect(router.sessionIdForAgent(AGENT)).toBe(SESSION)
  })

  it('reports an identity removed while host registration was settling instead of waking anything', async () => {
    const registry = detachedOwner()
    const boot = deferred()
    const wakeSession = vi.fn(async () => {})
    const router = new SessionpageLocalDeliveryRouter([localSessionDeliveryTarget], {
      waitUntilReady: () => boot.promise, wakeSession,
    })
    const wake = router.wakeAgentSession(AGENT)
    registry.unregisterAgent(AGENT)
    boot.resolve()
    await expect(wake).rejects.toThrow(SessionWakeError)
    await expect(wake).rejects.toThrow('has no session on this machine')
    expect(wakeSession).not.toHaveBeenCalled()
  })

  it('surfaces a real wake failure and allows a later request without claiming readiness', async () => {
    detachedOwner()
    const wakeSession = vi.fn()
      .mockRejectedValueOnce(new Error('provider resume failed'))
      .mockResolvedValueOnce(undefined)
    const onWakeComplete = vi.fn()
    const router = new SessionpageLocalDeliveryRouter([localSessionDeliveryTarget], {
      wakeSession, onWakeComplete,
    })
    await expect(router.wakeAgentSession(AGENT)).rejects.toThrow('provider resume failed')
    expect(onWakeComplete).not.toHaveBeenCalled()
    expect(router.sessionIdForAgent(AGENT)).toBe(SESSION)
    await router.wakeAgentSession(AGENT)
    expect(wakeSession).toHaveBeenCalledTimes(2)
    expect(onWakeComplete).toHaveBeenCalledOnce()
  })

  it('does not report wake-complete for an identity remapped while its old conversation was reopening', async () => {
    const registry = detachedOwner()
    const reopened = deferred()
    const wakeSession = vi.fn(() => reopened.promise)
    const onWakeComplete = vi.fn()
    const router = new SessionpageLocalDeliveryRouter([localSessionDeliveryTarget], { wakeSession, onWakeComplete })
    const wake = router.wakeAgentSession(AGENT)
    await vi.waitFor(() => expect(wakeSession).toHaveBeenCalledExactlyOnceWith(SESSION))
    registry.registerOffline(AGENT, { sessionId: 'replacement-conversation', providerId: 'codex' })
    reopened.resolve()
    await wake
    expect(onWakeComplete).not.toHaveBeenCalled()
  })

  it('does not respawn or repeatedly kick a registered local-session waiting for provider readiness', async () => {
    const registry = detachedOwner()
    registry.registerLive(AGENT, {
      sessionId: SESSION, providerId: 'pi',
      sendMessage: async () => ({ status: 'not-ready' }),
    })
    const wakeSession = vi.fn(async () => {})
    const onWakeComplete = vi.fn()
    // 引擎进程在跑(session-process 的事实)⇒ 唤醒什么也起不了:不重开,也不踢收件箱再拉一次。
    const router = new SessionpageLocalDeliveryRouter([localSessionDeliveryTarget], {
      wakeSession, onWakeComplete, processRunning: (id) => id === SESSION,
    })
    await router.wakeAgentSession(AGENT)
    expect(wakeSession).not.toHaveBeenCalled()
    expect(onWakeComplete).not.toHaveBeenCalled()
  })
})

describe('#5421 no wake loop for owners that go live on their own', () => {
  it('never reopens a codex app-server style owner whose engine is running, however often the inbox asks', async () => {
    // codex app-server / opencode / droid 原来声明 on-live-only:它们由会话转 live 时叫醒读者。现在不按腿声明,
    // 而按「引擎进程在不在跑」:在跑 ⇒ 不重开、不踢 wake-complete,收件箱怎么反复要都不会转圈。
    const wakeSession = vi.fn(async () => {})
    const onWakeComplete = vi.fn()
    const native: SessionpageDeliveryTarget = {
      liveSessionIdByAgent: (id) => id === AGENT ? SESSION : null,
      deliveryKeyForSession: (id) => id === SESSION ? 'thread-1' : null,
      sessionProviderSurface: () => ({ providerId: 'codex', surface: 'tui' }),
      tryInjectSessionMessage: async () => false,
    }
    const router = new SessionpageLocalDeliveryRouter([native], { wakeSession, onWakeComplete, processRunning: () => true })
    const bridge = createSessionpageDeliveryBridge(router)
    for (let i = 0; i < 5; i += 1) {
      expect(await bridge.injectAgentInbox!({ agentUserId: AGENT, messageId: `m-${i}`, text: 'hi' })).toBe('not-live')
      await router.wakeAgentSession(AGENT)
    }
    expect(wakeSession).not.toHaveBeenCalled()
    expect(onWakeComplete).not.toHaveBeenCalled()
  })

  it('reopens the same owner once its engine is gone', async () => {
    const wakeSession = vi.fn(async () => {})
    const onWakeComplete = vi.fn()
    let running = true
    const native: SessionpageDeliveryTarget = {
      liveSessionIdByAgent: (id) => id === AGENT ? SESSION : null,
      deliveryKeyForSession: (id) => id === SESSION ? 'thread-1' : null,
      sessionProviderSurface: () => ({ providerId: 'codex', surface: 'tui' }),
      tryInjectSessionMessage: async () => false,
    }
    const router = new SessionpageLocalDeliveryRouter([native], { wakeSession, onWakeComplete, processRunning: () => running })
    await router.wakeAgentSession(AGENT)
    expect(wakeSession).not.toHaveBeenCalled()
    running = false
    await router.wakeAgentSession(AGENT)
    expect(wakeSession).toHaveBeenCalledExactlyOnceWith(SESSION)
    expect(onWakeComplete).toHaveBeenCalledExactlyOnceWith(AGENT, SESSION)
  })
})

describe('#6546 session-direct to a cold target', () => {
  const direct = { id: 'direct-1', text: 'direct message', kind: 'session-direct' as const }

  /** 冷目标:只有离线占位;宿主恢复期间 native 属主上岗,准入口由测试控制。 */
  function coldTarget(opts: { admission?: () => Promise<void> } = {}) {
    const registry = detachedOwner()
    const inputs: string[] = []
    const order: string[] = []
    let live = false
    const native: SessionpageDeliveryTarget = {
      liveSessionIdByAgent: (id) => live && id === AGENT ? SESSION : null,
      deliveryKeyForSession: (id) => live && id === SESSION ? SESSION : null,
      sessionProviderSurface: () => live ? { providerId: 'codex', surface: 'tui' } : null,
      waitUntilReady: async (id) => {
        order.push(`admission:${id}`)
        await opts.admission?.()
      },
      tryInjectSessionMessage: async (_id, message) => { inputs.push(message.text); return true },
    }
    const wakeSession = vi.fn(async (id: string) => {
      order.push(`wake:${id}`)
      registry.unregisterAgent(AGENT)
      live = true
    })
    const router = new SessionpageLocalDeliveryRouter([localSessionDeliveryTarget, native], { wakeSession })
    const send = () => router.injectWithWake(SESSION, async () => (await router.tryInjectSessionMessage(SESSION, direct)) || 'not-live' as const)
    return { router, inputs, order, wakeSession, send }
  }

  it('wakes through the inbox recovery, waits for the current owner admission, then delivers', async () => {
    const { router, inputs, order, wakeSession, send } = coldTarget()
    // 注入本身不起会话:唤醒由发送方 await,不在 adapter 里另踢一脚。
    expect(await router.tryInjectSessionMessage(SESSION, direct)).toBe(false)
    expect(wakeSession).not.toHaveBeenCalled()

    await expect(send()).resolves.toBe(true)
    expect(order).toEqual([`wake:${SESSION}`, `admission:${SESSION}`])
    expect(inputs).toEqual([direct.text])
  })

  it('starts the cold session once for concurrent senders', async () => {
    const { wakeSession, send } = coldTarget()
    await Promise.all([send(), send()])
    expect(wakeSession).toHaveBeenCalledExactlyOnceWith(SESSION)
  })

  it('surfaces a failed resume to the sender instead of reporting the target ready', async () => {
    detachedOwner()
    const wakeSession = vi.fn(async () => { throw new Error('provider session is missing; cannot resume') })
    const router = new SessionpageLocalDeliveryRouter([localSessionDeliveryTarget], { wakeSession })
    const send = router.injectWithWake(SESSION, async () => (await router.tryInjectSessionMessage(SESSION, direct)) || 'not-live' as const)
    await expect(send).rejects.toThrow(/reopening the session failed: .*provider session is missing/)
  })

  it('surfaces a failed admission after the resume', async () => {
    const { inputs, send } = coldTarget({ admission: async () => { throw new Error('mcp tools/list never arrived') } })
    await expect(send()).rejects.toThrow(/the session was reopened but was not admitted: .*tools\/list never arrived/)
    expect(inputs).toEqual([])
  })

  it('reports a running engine whose channel does not accept, without reopening it (#6992 shape)', async () => {
    // 引擎还在跑(接回的 tmux claude),注册也在,通道却不收:唤醒什么也起不了 ⇒ 不重开,带码报回发送方。
    const wakeSession = vi.fn(async () => {})
    const native: SessionpageDeliveryTarget = {
      liveSessionIdByAgent: (id) => id === AGENT ? SESSION : null,
      deliveryKeyForSession: (id) => id === SESSION ? SESSION : null,
      sessionProviderSurface: () => ({ providerId: 'claude', surface: 'tui' }),
      tryInjectSessionMessage: async () => false,
    }
    const router = new SessionpageLocalDeliveryRouter([native], { wakeSession, processRunning: () => true })
    const send = router.injectWithWake(SESSION, async () => (await router.tryInjectSessionMessage(SESSION, direct)) || 'not-live' as const)
    await expect(send).rejects.toBeInstanceOf(SessionWakeError)
    await expect(send).rejects.toThrow('the engine is running (not reopened) but its delivery channel did not accept the message')
    expect(wakeSession).not.toHaveBeenCalled()
  })
})
