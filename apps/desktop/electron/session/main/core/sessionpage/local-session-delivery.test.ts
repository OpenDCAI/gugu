import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearLocalSessionDeliveryFailuresForTest,
  createLocalSessionDeliveryBridge,
  clearLocalSessionInjectionAuditForTest,
  localSessionDeliveryTarget,
  readLocalSessionInjectionAuditForTest,
  replaceLiveWithOfflineForSession,
  readLocalSessionDeliveryFailuresForTest,
  registerOfflineLocalSessionDelivery,
  registerLocalSessionDelivery,
  unregisterLocalSessionDelivery,
  unregisterLocalSessionDeliveryForAgent,
  withSessionLiveInboxKick,
  type LocalSessionBinding,
  type LocalSessionDeliveryBridge,
} from '../../../../sessionpage/local-session-delivery'
import {
  registerLocalSessionDelivery as registerThroughBridge,
  replaceLiveWithOfflineForSession as replaceThroughBridge,
  setLocalSessionDeliveryBridge,
  unregisterLocalSessionDelivery as unregisterThroughBridge,
} from './local-session-delivery'
import { SessionpageLocalDeliveryRouter } from '../../../../sessionpage/session-injection'
import {
  clearSessionpageSessionIntegrationOverridesForTest,
  setSessionpageSessionIntegrationOverrideForTest,
} from '@gugu/session-plugins/agents'

describe('local-session taskpage delivery owner', () => {
  it('uses native admission through the host bridge and rejects a replaced owner', async () => {
    const bridge = createLocalSessionDeliveryBridge()
    const admitted = Promise.withResolvers<void>()
    const sendMessage = vi.fn()
    bridge.registerLive('agent-admission', {
      sessionId: 'conv-a', providerId: 'pi', sendMessage,
      waitUntilReady: () => admitted.promise,
    })
    const waiting = expect(localSessionDeliveryTarget.waitUntilReady!('conv-a')).rejects.toThrow('owner changed')
    bridge.registerLive('agent-admission', {
      sessionId: 'conv-a', providerId: 'pi', sendMessage,
      waitUntilReady: async () => undefined,
    })
    admitted.resolve()
    await waiting
    await expect(localSessionDeliveryTarget.waitUntilReady!('conv-a')).resolves.toBeUndefined()
    expect(sendMessage).not.toHaveBeenCalled()
    bridge.replaceLiveWithOfflineForSession('conv-a')
    await expect(localSessionDeliveryTarget.waitUntilReady!('conv-a')).rejects.toThrow('no live native admission')
  })

  it('does not admit a live PTY without a native readiness source', async () => {
    registerLocalSessionDelivery('agent-admission', {
      sessionId: 'conv-a', providerId: 'pi', sendMessage: vi.fn(),
    })
    await expect(localSessionDeliveryTarget.waitUntilReady!('conv-a')).rejects.toThrow('no live native admission')
  })

  it('reads the live owner’s own turn activity through the bridge', () => {
    const bridge = createLocalSessionDeliveryBridge()
    let busy = true
    bridge.registerLive('agent-activity', {
      sessionId: 'conv-a', providerId: 'pi', sendMessage: vi.fn(), isTurnInFlight: () => busy,
    })
    expect(localSessionDeliveryTarget.isSessionTurnInFlight!('conv-a')).toBe(true)
    busy = false
    expect(localSessionDeliveryTarget.isSessionTurnInFlight!('conv-a')).toBe(false)
    // A replacement owner answers for itself; the retired closure above must not keep answering.
    bridge.registerLive('agent-activity', {
      sessionId: 'conv-a', providerId: 'pi', sendMessage: vi.fn(), isTurnInFlight: () => true,
    })
    expect(localSessionDeliveryTarget.isSessionTurnInFlight!('conv-a')).toBe(true)
  })

  it('does not report a live PTY as idle when it has no turn activity source', () => {
    registerLocalSessionDelivery('agent-activity', {
      sessionId: 'conv-a', providerId: 'pi', sendMessage: vi.fn(),
    })
    expect(() => localSessionDeliveryTarget.isSessionTurnInFlight!('conv-a'))
      .toThrow('no live turn activity source')
  })

  it('answers no turn for a conversation this owner is not live for', () => {
    expect(localSessionDeliveryTarget.isSessionTurnInFlight!('conv-a')).toBe(false)
  })

  beforeEach(() => {
    vi.stubEnv('GUGU_SESSION_TEST_HOOKS', '1')
    clearLocalSessionDeliveryFailuresForTest()
    clearLocalSessionInjectionAuditForTest()
  })

  afterEach(() => {
    // The session-page side's bridge is installed only by the test that exercises it.
    setLocalSessionDeliveryBridge(null)
    clearLocalSessionDeliveryFailuresForTest()
    clearLocalSessionInjectionAuditForTest()
    clearSessionpageSessionIntegrationOverridesForTest()
    for (const sessionId of [
      'conv-droid', 'conv-a', 'conv-b', 'conv-c', 'conv-d',
    ]) unregisterLocalSessionDelivery(sessionId)
    vi.unstubAllEnvs()
  })

  it('routes the session-page side through the bridge the host installed', async () => {
    const bindings = new Map<string, LocalSessionBinding>()
    const offline = new Map<string, { sessionId: string; providerId: string }>()
    const sendMessage = vi.fn().mockResolvedValue({ status: 'accepted', messageId: 'boundary-1' })
    const bridge: LocalSessionDeliveryBridge = {
      registerLive: vi.fn((agentUserId, binding) => {
        bindings.set(agentUserId, binding)
        offline.delete(agentUserId)
      }),
      registerOffline: vi.fn((agentUserId, binding) => {
        bindings.delete(agentUserId)
        offline.set(agentUserId, binding)
      }),
      replaceLiveWithOfflineForSession: vi.fn((sessionId) => {
        const entry = [...bindings.entries()].find(([, binding]) => binding.sessionId === sessionId)
        if (!entry) return false
        bindings.delete(entry[0])
        offline.set(entry[0], { sessionId, providerId: entry[1].providerId })
        return true
      }),
      unregisterSession: vi.fn((sessionId) => {
        for (const [agentUserId, binding] of bindings) if (binding.sessionId === sessionId) bindings.delete(agentUserId)
        for (const [agentUserId, binding] of offline) if (binding.sessionId === sessionId) offline.delete(agentUserId)
      }),
      unregisterAgent: vi.fn((agentUserId) => {
        bindings.delete(agentUserId)
        offline.delete(agentUserId)
      }),
      liveSessionIdByAgent: (agentUserId) => bindings.get(agentUserId)?.sessionId
        ?? offline.get(agentUserId)?.sessionId
        ?? null,
      deliveryKeyForSession: (sessionId) =>
        [...bindings.values(), ...offline.values()].some((binding) => binding.sessionId === sessionId)
          ? sessionId
          : null,
      tryInjectSessionMessage: async (sessionId, message) => {
        const binding = [...bindings.values()].find((candidate) => candidate.sessionId === sessionId)
        if (!binding) return false
        return (await binding.sendMessage(message)).status === 'accepted'
      },
    }
    setLocalSessionDeliveryBridge(bridge)

    registerThroughBridge('agent-boundary', {
      sessionId: 'conv-boundary',
      providerId: 'pi',
      sendMessage,
    })
    expect(bridge.registerLive).toHaveBeenCalledOnce()
    expect(bridge.liveSessionIdByAgent('agent-boundary')).toBe('conv-boundary')
    await expect(bridge.tryInjectSessionMessage('conv-boundary', {
      id: 'boundary-1',
      text: 'cross bundle callback',
    })).resolves.toBe(true)
    expect(sendMessage).toHaveBeenCalledWith({
      id: 'boundary-1',
      text: 'cross bundle callback',
    })

    expect(replaceThroughBridge('conv-boundary')).toBe(true)
    expect(bridge.replaceLiveWithOfflineForSession).toHaveBeenCalledWith('conv-boundary')
    expect(bridge.deliveryKeyForSession('conv-boundary')).toBe('conv-boundary')
    unregisterThroughBridge('conv-boundary')
    expect(bridge.unregisterSession).toHaveBeenCalledWith('conv-boundary')
    expect(bridge.liveSessionIdByAgent('agent-boundary')).toBeNull()
  })

  it('shares the owner table across the bridge boundary', () => {
    const bridge = createLocalSessionDeliveryBridge()
    registerLocalSessionDelivery('agent-shared-table', {
      sessionId: 'conv-shared-table',
      providerId: 'pi',
      sendMessage: async () => ({ status: 'accepted' as const, messageId: 'shared-table' }),
    })

    expect(bridge.listOwners?.()).toEqual([
      expect.objectContaining({
        agentUserId: 'agent-shared-table',
        sessionId: 'conv-shared-table',
        state: 'live',
      }),
    ])
    unregisterLocalSessionDelivery('conv-shared-table')
  })

  it('reads owners written through the bridge handle in both live and offline states', () => {
    const bridge = createLocalSessionDeliveryBridge()
    bridge.registerLive('agent-bridge-live', {
      sessionId: 'conv-bridge-live',
      providerId: 'pi',
      sendMessage: async () => ({ status: 'accepted' as const, messageId: 'bridge-live' }),
    })
    expect(bridge.listOwners?.()).toEqual([
      expect.objectContaining({ agentUserId: 'agent-bridge-live', state: 'live' }),
    ])

    bridge.registerOffline('agent-bridge-offline', {
      sessionId: 'conv-bridge-offline',
      providerId: 'pi',
    })
    expect(bridge.listOwners?.()).toEqual([
      expect.objectContaining({ agentUserId: 'agent-bridge-live', state: 'live' }),
      expect.objectContaining({ agentUserId: 'agent-bridge-offline', state: 'offline' }),
    ])
    bridge.unregisterSession('conv-bridge-live')
    bridge.unregisterSession('conv-bridge-offline')
  })

  it('routes a Contacts delivery through the registered provider session sender', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ status: 'accepted', messageId: 'm1' })
    registerLocalSessionDelivery('agent-droid', {
      sessionId: 'conv-droid',
      providerId: 'droid',
      sendMessage,
    })

    await expect(localSessionDeliveryTarget.tryInjectSessionMessage?.('conv-droid', {
      id: 'm1',
      text: 'hello from Contacts',
    })).resolves.toBe(true)
    expect(sendMessage).toHaveBeenCalledWith({ id: 'm1', text: 'hello from Contacts' })
    expect(localSessionDeliveryTarget.liveSessionIdByAgent('agent-droid')).toBe('conv-droid')
    expect(readLocalSessionInjectionAuditForTest()).toEqual([
      expect.objectContaining({
        sessionId: 'conv-droid',
        providerId: 'droid',
        messageId: 'm1',
        text: 'hello from Contacts',
      }),
    ])
  })

  it('lets the taskpage router select the local-session target by conversation id', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ status: 'accepted', messageId: 'router-1' })
    registerLocalSessionDelivery('agent-droid', {
      sessionId: 'conv-droid',
      providerId: 'droid',
      sendMessage,
    })
    const router = new SessionpageLocalDeliveryRouter([localSessionDeliveryTarget])

    await expect(router.tryInjectSessionMessage('conv-droid', {
      id: 'router-1',
      text: 'router selection',
    })).resolves.toBe(true)
    expect(sendMessage).toHaveBeenCalledOnce()
  })

  it('uses the conversation-keyed owner as the only injection authority', async () => {
    const recipientUserId = '00000000-0000-4000-8000-000000000101'
    const message = {
      id: '00000000-0000-4000-8000-000000000102',
      text: 'same conversation, one adapter',
    }
    const agentIndexedTarget = {
      deliveryTargetName: 'agent-indexed-target',
      liveSessionIdByAgent: (agentUserId: string) => agentUserId === recipientUserId ? 'conv-route' : null,
      deliveryKeyForSession: () => null,
      sessionProviderSurface: () => ({ providerId: 'claude', surface: 'tui' as const }),
      tryInjectSessionMessage: vi.fn().mockResolvedValue(true),
    }
    const sessionIndexedTarget = {
      deliveryTargetName: 'conversation-indexed-target',
      liveSessionIdByAgent: () => null,
      deliveryKeyForSession: (sessionId: string) => sessionId === 'conv-route' ? sessionId : null,
      sessionProviderSurface: () => ({ providerId: 'claude', surface: 'tui' as const }),
      tryInjectSessionMessage: vi.fn().mockResolvedValue(true),
    }
    const router = new SessionpageLocalDeliveryRouter([agentIndexedTarget, sessionIndexedTarget])

    // S2b pull flip: the reader's injectForAgent resolves the agent index only to find the
    // conversation, then the conversation-keyed owner is the ONLY adapter allowed to accept bytes.
    await expect(router.injectForAgent(recipientUserId, message)).resolves.toBe('accepted')
    expect(agentIndexedTarget.tryInjectSessionMessage).not.toHaveBeenCalled()
    expect(sessionIndexedTarget.tryInjectSessionMessage).toHaveBeenCalledWith('conv-route', message)
  })

  it('keeps the router mapped and pending during the PTY replacement gap', async () => {
    registerLocalSessionDelivery('agent-droid', {
      sessionId: 'conv-droid',
      providerId: 'droid',
      sendMessage: vi.fn(),
    })
    expect(replaceLiveWithOfflineForSession('conv-droid')).toBe(true)
    const router = new SessionpageLocalDeliveryRouter([localSessionDeliveryTarget])

    expect(router.deliveryTargetFor('agent-droid')).toBe(localSessionDeliveryTarget)
    await expect(router.tryInjectSessionMessage('conv-droid', {
      id: 'replacement-gap',
      text: 'must remain pending',
    })).resolves.toBe(false)
  })

  it('claims an offline restart binding so bridge delivery stays pending instead of falling through', async () => {
    registerOfflineLocalSessionDelivery('agent-droid', {
      sessionId: 'conv-droid',
      providerId: 'droid',
    })
    const router = new SessionpageLocalDeliveryRouter([localSessionDeliveryTarget])

    expect(router.deliveryTargetFor('agent-droid')).toBe(localSessionDeliveryTarget)
    expect(localSessionDeliveryTarget.deliveryKeyForSession?.('conv-droid')).toBe('conv-droid')
    await expect(localSessionDeliveryTarget.tryInjectSessionMessage?.('conv-droid', {
      id: 'offline-1',
      text: 'wait for PTY',
    })).resolves.toBe(false)
  })

  it('atomically replaces live and offline owners across both agent and conversation indexes', () => {
    registerOfflineLocalSessionDelivery('agent-a', {
      sessionId: 'conv-a',
      providerId: 'droid',
    })
    registerLocalSessionDelivery('agent-b', {
      sessionId: 'conv-a',
      providerId: 'droid',
      sendMessage: vi.fn(),
    })
    expect(localSessionDeliveryTarget.liveSessionIdByAgent('agent-a')).toBeNull()
    expect(localSessionDeliveryTarget.liveSessionIdByAgent('agent-b')).toBe('conv-a')

    registerLocalSessionDelivery('agent-b', {
      sessionId: 'conv-b',
      providerId: 'droid',
      sendMessage: vi.fn(),
    })
    expect(localSessionDeliveryTarget.liveSessionIdByAgent('agent-b')).toBe('conv-b')
    expect(localSessionDeliveryTarget.deliveryKeyForSession?.('conv-a')).toBeNull()

    registerOfflineLocalSessionDelivery('agent-c', {
      sessionId: 'conv-b',
      providerId: 'droid',
    })
    expect(localSessionDeliveryTarget.liveSessionIdByAgent('agent-b')).toBeNull()
    expect(localSessionDeliveryTarget.liveSessionIdByAgent('agent-c')).toBe('conv-b')
    expect(localSessionDeliveryTarget.deliveryKeyForSession?.('conv-b')).toBe('conv-b')
  })

  it('clears only the reaped conversation and cannot remove a replacement binding for the same agent', () => {
    registerOfflineLocalSessionDelivery('agent-droid', {
      sessionId: 'conv-droid',
      providerId: 'droid',
    })

    // A stale reap for the old conversation must leave a replacement owner intact.
    registerLocalSessionDelivery('agent-droid', {
      sessionId: 'conv-a',
      providerId: 'droid',
      sendMessage: vi.fn(),
    })
    unregisterLocalSessionDeliveryForAgent('agent-droid', 'conv-droid')
    expect(localSessionDeliveryTarget.liveSessionIdByAgent('agent-droid')).toBe('conv-a')

    unregisterLocalSessionDeliveryForAgent('agent-droid', 'conv-a')
    expect(localSessionDeliveryTarget.liveSessionIdByAgent('agent-droid')).toBeNull()
  })

  it('fails the same route when the taskpage cell is mutated to none', async () => {
    registerLocalSessionDelivery('agent-pi', {
      sessionId: 'conv-pi',
      providerId: 'pi',
      sendMessage: vi.fn(),
    })
    setSessionpageSessionIntegrationOverrideForTest({
      providerId: 'pi',
      surface: 'tui',
      identity: 'none',
      messageTransport: 'none',
    })

    await expect(localSessionDeliveryTarget.tryInjectSessionMessage?.('conv-pi', {
      id: 'm2',
      text: 'must fail',
    })).rejects.toThrow('does not declare a local-session message transport')
    expect(readLocalSessionDeliveryFailuresForTest()).toEqual([
      expect.objectContaining({ providerId: 'pi', messageId: 'm2', text: 'must fail' }),
    ])
  })
})

// S2b 读者触发③的 A/B 判据:先证明「没有包装」时积压不会被踢(A/红形状),再证明包装后
// 转 live 恰好踢一次(B)。缺了这个挂点,TUI 面板打开后积压要等下一条新消息才到 —— 不 fail loud。
describe('withSessionLiveInboxKick (S2b 触发③)', () => {
  it('A(红形状):裸 bridge 的 registerLive 不踢收件箱 —— 这就是补挂点之前的行为', () => {
    const kicks: string[] = [];
    const bridge = createLocalSessionDeliveryBridge();
    bridge.registerLive('agent-live-a', {
      sessionId: 'conv-live-a',
      providerId: 'opencode',
      sendMessage: async () => ({ status: 'accepted' as const, messageId: 'x' }),
    });
    expect(kicks).toEqual([]);
    unregisterLocalSessionDelivery('conv-live-a');
  });

  it('B:包装后转 live 恰好踢一次,且注册本身先于踢发生', () => {
    const kicks: string[] = [];
    const bridge = withSessionLiveInboxKick(createLocalSessionDeliveryBridge(), (agentUserId, sessionId) => {
      // 注册必须已完成:踢的那一刻注入点已可用。宿主拿 conversationId 排同一会话的 outbox(#4896)。
      expect(bridge.liveSessionIdByAgent(agentUserId)).toBe('conv-live-b');
      expect(sessionId).toBe('conv-live-b');
      kicks.push(agentUserId);
    });
    bridge.registerLive('agent-live-b', {
      sessionId: 'conv-live-b',
      providerId: 'opencode',
      sendMessage: async () => ({ status: 'accepted' as const, messageId: 'x' }),
    });
    expect(kicks).toEqual(['agent-live-b']);
    unregisterLocalSessionDelivery('conv-live-b');
  });
});
