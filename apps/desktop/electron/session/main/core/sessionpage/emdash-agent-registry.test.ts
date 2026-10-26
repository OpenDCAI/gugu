import { afterEach, describe, expect, it, vi } from 'vitest'

const warn = vi.hoisted(() => vi.fn())
vi.mock('../../../../lib/logger', () => ({
  createLogger: () => ({ warn }),
}))

import {
  emdashAgentRegistry,
  RECONNECT_BUDGET_MS,
  registerEmdashAgent,
  resolveLocalSessionPeers,
  unregisterEmdashAgent,
} from '../../../../sessionpage/emdash-agent-registry'

describe('session peer sidebar titles', () => {
  const binding = { guguAgentUserId: '11111111-1111-4111-8111-111111111111', sessionId: 'conversation-1' }
  const identity = {
    id: binding.guguAgentUserId,
    gugu_number: null,
    display_name: 'Contact name',
  }

  const facts = (sessionId: string, title: string, extra: Record<string, unknown> = {}) => ({
    sessionId,
    title,
    projectName: 'gugu',
    status: null,
    isPinned: false,
    lastInteractedAt: null,
    ...extra,
  })

  it('returns the session-page title separately from the contact identity name, with the sidebar facts', () => {
    expect(resolveLocalSessionPeers(
      [binding],
      [identity],
      [facts(binding.sessionId, 'Review delivery routing', {
        status: { status: 'needs_user', detail: 'approval' },
        isPinned: true,
        lastInteractedAt: '2026-09-26T10:00:00.000Z',
      })],
    )).toEqual([{
      identity: { users: identity },
      sessionId: binding.sessionId,
      title: 'Review delivery routing',
      project: 'gugu',
      status: 'needs_user',
      detail: 'approval',
      pinned: true,
      last_active_at: '2026-09-26T10:00:00.000Z',
    }])
  })

  it('orders rows most recently active first; never-active rows go last', () => {
    const second = { guguAgentUserId: '22222222-2222-4222-8222-222222222222', sessionId: 'conversation-2' }
    const third = { guguAgentUserId: '33333333-3333-4333-8333-333333333333', sessionId: 'conversation-3' }
    const peers = resolveLocalSessionPeers(
      [binding, second, third],
      [identity, { ...identity, id: second.guguAgentUserId }, { ...identity, id: third.guguAgentUserId }],
      [
        facts(binding.sessionId, 'Never touched'),
        facts(second.sessionId, 'Older', { lastInteractedAt: '2026-09-25T10:00:00.000Z' }),
        facts(third.sessionId, 'Newer', { lastInteractedAt: '2026-09-26T10:00:00.000Z' }),
      ],
    )
    expect(peers.map((peer) => peer.title)).toEqual(['Newer', 'Older', 'Never touched'])
  })

  it('fails when the session-page title is missing or ambiguous', () => {
    expect(() => resolveLocalSessionPeers(
      [binding],
      [identity],
      [],
    )).toThrow(/no sidebar title/)
    expect(() => resolveLocalSessionPeers(
      [binding],
      [identity],
      [
        facts(binding.sessionId, 'First'),
        facts(binding.sessionId, 'Second'),
      ],
    )).toThrow(/ambiguous sessionId/)
  })
})

describe('emdash ACP session-direct live-only delivery', () => {
  it.each(['starting', 'closed', 'lost'])('does not admit an ACP owner in %s state', async (lifecycle) => {
    emdashAgentRegistry.setBridge({
      injectEmdashPromptDetached: vi.fn(async () => ({ outcome: 'started' as const, completion: Promise.resolve(), turnId: 'unused' })),
      emdashSessionSummaries: async () => [{ sessionId: 'conv-child', providerId: 'codex', lifecycle, isGenerating: false }],
    })
    await expect(emdashAgentRegistry.waitUntilReady('conv-child')).rejects.toThrow('has not admitted')
  })

  it('admits an ACP owner only from its runtime ready state', async () => {
    emdashAgentRegistry.setBridge({
      injectEmdashPromptDetached: vi.fn(async () => ({ outcome: 'started' as const, completion: Promise.resolve(), turnId: 'unused' })),
      emdashSessionSummaries: async () => [{ sessionId: 'conv-child', providerId: 'codex', lifecycle: 'ready', isGenerating: false }],
    })
    await expect(emdashAgentRegistry.waitUntilReady('conv-child')).resolves.toBeUndefined()
  })

  it('withdraws a closing owner from injection capability before the process exits', async () => {
    const inject = vi.fn(async () => ({ outcome: 'started' as const, completion: Promise.resolve(), turnId: 'unused' }))
    emdashAgentRegistry.setBridge({ injectEmdashPromptDetached: inject,
      emdashSessionSummaries: async () => [{ sessionId: 'conv-child', providerId: 'claude',
        lifecycle: 'ready', closing: true, isGenerating: false }],
    })
    expect(await emdashAgentRegistry.sessionProviderSurface('conv-child')).toBeNull()
    expect(await emdashAgentRegistry.tryInjectSessionMessage('conv-child', { id: 'input', text: 'hi' })).toBe(false)
    expect(inject).not.toHaveBeenCalled()
    await expect(emdashAgentRegistry.waitUntilReady('conv-child')).rejects.toThrow('has not admitted')
  })

  it('reopens a pre-turn missing session once for a message, and stops retrying if its provider refuses again', async () => {
    const ensure = vi.fn(async () => undefined)
    emdashAgentRegistry.setBridge({ ensureEmdashSession: ensure,
      injectEmdashPromptDetached: vi.fn(async () => ({ outcome: 'missing' as const, completion: Promise.resolve() })),
      emdashSessionSummaries: async () => [{ sessionId: 'conv-child', providerId: 'claude', lifecycle: 'ready', isGenerating: false }],
    })
    const input = { id: 'same-input', text: 'hi' }
    expect(await emdashAgentRegistry.tryInjectSessionMessage('conv-child', input)).toBe(false)
    expect(ensure).toHaveBeenCalledTimes(1)
    await expect(emdashAgentRegistry.tryInjectSessionMessage('conv-child', input)).rejects.toThrow('again after recovery')
    expect(ensure).toHaveBeenCalledTimes(1)
  })

  afterEach(() => {
    emdashAgentRegistry.setBridge(null)
    unregisterEmdashAgent('agent-child')
    unregisterEmdashAgent('agent-failed-child')
    warn.mockReset()
    vi.restoreAllMocks()
  })

  it('does not wake a dormant mapped conversation for session-direct', async () => {
    let live = false
    const ensureEmdashSession = vi.fn(async () => {
      live = true
    })
    const injectEmdashPromptDetached = vi.fn(async () => ({ outcome: 'started' as const, completion: Promise.resolve(), turnId: 'unused' }))
    const bridge = {
      ensureEmdashSession,
      injectEmdashPromptDetached,
      emdashSessionSummaries: vi.fn(async () => live
        ? [{ sessionId: 'conv-child', providerId: 'claude', lifecycle: 'ready', isGenerating: false }]
        : []),
    }
    emdashAgentRegistry.setBridge(bridge)
    registerEmdashAgent({
      guguAgentUserId: 'agent-child',
      sessionId: 'conv-child',
    })

    await expect(emdashAgentRegistry.tryInjectSessionMessage('conv-child', {
      id: 'message-1',
      text: 'wake me',
      kind: 'session-direct',
    })).resolves.toBe(false)
    expect(ensureEmdashSession).not.toHaveBeenCalled()
    expect(injectEmdashPromptDetached).not.toHaveBeenCalled()
  })

  it('does not attempt a wake when the session-direct target is dormant', async () => {
    const ensureEmdashSession = vi.fn(async () => undefined)
    emdashAgentRegistry.setBridge({
      ensureEmdashSession,
      injectEmdashPromptDetached: vi.fn(async () => ({ outcome: 'started' as const, completion: Promise.resolve(), turnId: 'unused' })),
      emdashSessionSummaries: vi.fn(async () => []),
    })
    registerEmdashAgent({
      guguAgentUserId: 'agent-failed-child',
      sessionId: 'conv-failed-child',
    })

    await expect(emdashAgentRegistry.tryInjectSessionMessage('conv-failed-child', {
      id: 'message-failed',
      text: 'remain durable',
      kind: 'session-direct',
    })).resolves.toBe(false)
    expect(ensureEmdashSession).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('keeps a live Claude ACP session on the ACP cell when no auxiliary owner is registered', async () => {
    emdashAgentRegistry.setBridge({
      injectEmdashPromptDetached: vi.fn(async () => ({
        outcome: 'started' as const,
        completion: Promise.resolve(),
        turnId: 'turn-claude',
      })),
      emdashSessionSummaries: vi.fn(async () => [{
        sessionId: 'conv-claude-acp',
        providerId: 'claude',
        lifecycle: 'ready',
        isGenerating: false,
      }]),
    })

    await expect(emdashAgentRegistry.tryInjectSessionMessage('conv-claude-acp', {
      id: 'message-claude',
      text: 'through ACP cell',
    })).resolves.toMatchObject({ turnId: 'turn-claude' })
  })

  // 编号 5 (10-12 片场试演): an adapter that exited on its own leaves the session `lost`. A message to it kicks its reconnect and
  // stays on the cursor — the delivery does not wait (148 r2: a wait there held the whole device's deliveries) — and when the
  // reconnect ends, the host pulls the inbox again: up, the batch goes in; failed, it fails loudly (its row in the chat).
  // Before: it went straight into the dead adapter and came back as「reconnect before sending」.
  describe('编号 5: a lost ACP session', () => {
    const settled = vi.fn()
    const deferred = () => {
      let resolve!: () => void
      let reject!: (error: Error) => void
      const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej })
      return { promise, resolve, reject }
    }
    const setUp = (sessionId: string, ensure: (id: string) => Promise<void>, lifecycleOf: () => string) => {
      const injectEmdashPromptDetached = vi.fn(async () => {
        if (lifecycleOf() === 'lost') throw new Error(`Session '${sessionId}' lost its ACP adapter: ACP adapter exited unexpectedly (code 1); reconnect before sending`)
        return { outcome: 'started' as const, completion: Promise.resolve(), turnId: 'turn-after-reconnect' }
      })
      const ensureEmdashSession = vi.fn(ensure)
      emdashAgentRegistry.setBridge({
        ensureEmdashSession,
        injectEmdashPromptDetached,
        emdashSessionSummaries: vi.fn(async () => [{ sessionId, providerId: 'claude', lifecycle: lifecycleOf(), isGenerating: false }]),
      })
      emdashAgentRegistry.setReconnectSettledHook(settled)
      registerEmdashAgent({ guguAgentUserId: `agent-${sessionId}`, sessionId })
      const deliver = (text: string) => emdashAgentRegistry.tryInjectSessionMessage(sessionId, { id: 'm-1', text })
      return { ensureEmdashSession, injectEmdashPromptDetached, deliver }
    }

    afterEach(() => {
      emdashAgentRegistry.setReconnectSettledHook(null)
      for (const id of ['conv-up', 'conv-down', 'conv-loop', 'conv-hung', 'conv-again']) unregisterEmdashAgent(`agent-${id}`)
      settled.mockReset()
      vi.useRealTimers()
    })

    it('a message kicks the reconnect and returns at once; once up, the pull it triggers goes in', async () => {
      let lifecycle = 'lost'
      const up = deferred()
      const { ensureEmdashSession, injectEmdashPromptDetached, deliver } = setUp('conv-up', () => up.promise.then(() => { lifecycle = 'ready' }), () => lifecycle)
      await expect(deliver('are you there')).resolves.toBe(false)
      await expect(deliver('are you there')).resolves.toBe(false) // pulled again while it reconnects: still waiting
      expect(ensureEmdashSession).toHaveBeenCalledTimes(1)
      expect(settled).not.toHaveBeenCalled()
      up.resolve()
      await vi.waitFor(() => expect(settled).toHaveBeenCalledWith('agent-conv-up'))
      await expect(deliver('are you there')).resolves.toMatchObject({ turnId: 'turn-after-reconnect' })
      expect(injectEmdashPromptDetached).toHaveBeenCalledTimes(1)
    })

    it('a failed reconnect: the pull it triggers fails the batch, without going into the dead adapter', async () => {
      const { ensureEmdashSession, injectEmdashPromptDetached, deliver } = setUp('conv-down', async () => {
        throw new Error('session conv-down failed to reopen')
      }, () => 'lost')
      await expect(deliver('are you there')).resolves.toBe(false)
      await vi.waitFor(() => expect(settled).toHaveBeenCalledWith('agent-conv-down'))
      await expect(deliver('are you there')).rejects.toThrow('failed to reopen')
      expect(injectEmdashPromptDetached).not.toHaveBeenCalled()
      expect(ensureEmdashSession).toHaveBeenCalledTimes(1)
      await expect(deliver('are you there + a new message')).resolves.toBe(false) // said once; a new message tries again
      expect(ensureEmdashSession).toHaveBeenCalledTimes(2)
    })

    it('a reconnect not up within the budget fails the batch; the adapter is started once, and coming up late still goes in', async () => {
      vi.useFakeTimers()
      let lifecycle = 'lost'
      let starts = 0
      let start: Promise<void> | null = null
      const up = deferred()
      const { ensureEmdashSession, deliver } = setUp('conv-hung', () => start ??= (() => {
        // Like the runtime (mac1, 10-12): one start per session at a time (a second wake joins it); the adapter answers
        // initialize, the session is `replaying` while it is loaded — and the load is never answered.
        starts += 1
        lifecycle = 'replaying'
        return up.promise.then(() => { lifecycle = 'ready' })
      })(), () => lifecycle)
      await expect(deliver('are you there')).resolves.toBe(false)
      await expect(deliver('are you there')).resolves.toBe(false) // pulled again while it loads: waits, not「while 'replaying'」
      await vi.advanceTimersByTimeAsync(RECONNECT_BUDGET_MS - 1)
      expect(settled).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      await vi.waitFor(() => expect(settled).toHaveBeenCalledWith('agent-conv-hung'))
      const wakes = ensureEmdashSession.mock.calls.length
      await expect(deliver('are you there')).rejects.toThrow(`not reconnected within ${RECONNECT_BUDGET_MS}ms`)
      // 148 r3: while that start still goes, the person's retry after the row is said at once too — and wakes nothing.
      await expect(deliver('are you there + a retry')).rejects.toThrow(`not reconnected within ${RECONNECT_BUDGET_MS}ms`)
      expect(ensureEmdashSession.mock.calls.length).toBe(wakes)
      expect(starts).toBe(1)
      up.resolve()
      await vi.advanceTimersByTimeAsync(0)
      await expect(deliver('are you there + a retry')).resolves.toMatchObject({ turnId: 'turn-after-reconnect' })
    })

    // 148 r4: between the runtime having the session up and the host finishing its start (persistAcpStartResult), a pull must
    // not say the batch failed and then put the same batch in: up is up, the record goes and the batch is taken.
    it('a reconnect over the budget whose session is up by the pull: no failure, the batch goes in', async () => {
      vi.useFakeTimers()
      let lifecycle = 'lost'
      const up = deferred()
      const { deliver } = setUp('conv-hung', () => {
        lifecycle = 'replaying'
        return up.promise
      }, () => lifecycle)
      await expect(deliver('are you there')).resolves.toBe(false)
      await vi.advanceTimersByTimeAsync(RECONNECT_BUDGET_MS)
      await vi.waitFor(() => expect(settled).toHaveBeenCalledTimes(1))
      lifecycle = 'ready' // the runtime has it up; the host's start has not returned yet
      await expect(deliver('are you there')).resolves.toMatchObject({ turnId: 'turn-after-reconnect' })
      up.resolve()
      await vi.advanceTimersByTimeAsync(0)
      await expect(deliver('one more')).resolves.toMatchObject({ turnId: 'turn-after-reconnect' })
    })

    it('a reconnect that gave up fails every batch until its start ends; when the hung adapter is gone, the next message reconnects again', async () => {
      vi.useFakeTimers()
      let lifecycle = 'lost'
      let starts = 0
      const hung = deferred()
      const { deliver } = setUp('conv-hung', () => {
        starts += 1
        if (starts > 1) { lifecycle = 'ready'; return Promise.resolve() }
        lifecycle = 'replaying'
        return hung.promise // until its adapter is killed: then the runtime's start fails and the session is lost again
      }, () => lifecycle)
      await expect(deliver('first')).resolves.toBe(false)
      await vi.advanceTimersByTimeAsync(RECONNECT_BUDGET_MS)
      await vi.waitFor(() => expect(settled).toHaveBeenCalledTimes(1))
      await expect(deliver('first')).rejects.toThrow('not reconnected within')
      await expect(deliver('first + a retry')).rejects.toThrow('not reconnected within')
      lifecycle = 'lost'
      hung.reject(new Error('ACP adapter exited unexpectedly')) // the hung adapter killed
      await vi.advanceTimersByTimeAsync(0)
      await expect(deliver('first + a retry')).resolves.toBe(false)
      expect(starts).toBe(2)
      await vi.waitFor(() => expect(settled).toHaveBeenCalledTimes(2))
      await expect(deliver('first + a retry')).resolves.toMatchObject({ turnId: 'turn-after-reconnect' })
    })

    // 148's review: the reconnect's own pull brings the same batch again. An adapter that comes up and dies before taking it must
    // not be restarted round and round: one reconnect per batch, then the delivery fails (its row in the chat). A new message is
    // a new batch, and one more try.
    it('reconnects once per batch: the same messages again fail without another reconnect; new ones try again', async () => {
      const { ensureEmdashSession, deliver } = setUp('conv-loop', async () => undefined, () => 'lost') // up — and lost again
      await expect(deliver('batch one')).resolves.toBe(false)
      await vi.waitFor(() => expect(settled).toHaveBeenCalledTimes(1))
      await expect(deliver('batch one')).rejects.toThrow('not reconnecting it again')
      await expect(deliver('batch one')).rejects.toThrow('not reconnecting it again')
      expect(ensureEmdashSession).toHaveBeenCalledTimes(1)
      await expect(deliver('batch one + a new message')).resolves.toBe(false)
      expect(ensureEmdashSession).toHaveBeenCalledTimes(2)
    })

    // 148's review, the small one: once a batch is taken, the mark goes — the same text after a later loss reconnects again.
    it('drops the mark once the batch is taken', async () => {
      let lifecycle = 'lost'
      const { ensureEmdashSession, deliver } = setUp('conv-again', async () => { lifecycle = 'ready' }, () => lifecycle)
      await expect(deliver('same text')).resolves.toBe(false)
      await vi.waitFor(() => expect(settled).toHaveBeenCalledTimes(1))
      await expect(deliver('same text')).resolves.toMatchObject({ turnId: 'turn-after-reconnect' })
      lifecycle = 'lost'
      await expect(deliver('same text')).resolves.toBe(false)
      expect(ensureEmdashSession).toHaveBeenCalledTimes(2)
    })
  })
})

// #4708 —— session-direct 与读者路共用同一份时机旗:codex × acp 声明了 next-tool-call,
// `session_message` 忙时必须走 detached 受理路并带 steerIfBusy(mid-turn steer),❌ 不落会话机队列;
// 未声明的家(kimi)照旧不带旗 —— 直接尝试注入;若 provider 只返回 queued,宿主必须响亮失败。
describe('#4708 session-direct honors the per-harness injection tier', () => {
  afterEach(() => {
    emdashAgentRegistry.setBridge(null)
    vi.restoreAllMocks()
  })

  type InjectOpts = { steerIfBusy?: boolean; coalesceKey?: string } | undefined
  function bridgeFor(providerId: string) {
    const injectEmdashPromptDetached = vi.fn(async (_sessionId: string, _text: string, _opts?: InjectOpts) => ({
      outcome: 'started' as 'started' | 'queued',
      completion: Promise.resolve(),
      turnId: `turn-${providerId}`,
    }))
    emdashAgentRegistry.setBridge({
      injectEmdashPromptDetached,
      emdashSessionSummaries: vi.fn(async () => [{
        sessionId: `conv-${providerId}-acp`,
        providerId,
        lifecycle: 'ready',
        isGenerating: true,
      }]),
    })
    return { injectEmdashPromptDetached }
  }

  it.each(['codex', 'claude'])('steers a busy %s acp session through detached admission without wrapping the user text', async (providerId) => {
    const { injectEmdashPromptDetached } = bridgeFor(providerId)
    const sessionId = `conv-${providerId}-acp`
    const text = 'Check this result.\nKeep the original wording.'

    const receipt = await emdashAgentRegistry.tryInjectSessionMessage(sessionId, {
      id: 'count-off-1',
      text,
      kind: 'session-direct',
    })

    expect(injectEmdashPromptDetached).toHaveBeenCalledExactlyOnceWith(sessionId, text, { steerIfBusy: true })
    expect(receipt).toMatchObject({ turnId: `turn-${providerId}` })
  })

  it('preserves the deferred queue claim marker across the host bridge without another context claim', async () => {
    const { injectEmdashPromptDetached } = bridgeFor('codex')
    await emdashAgentRegistry.tryInjectSessionMessage('conv-codex-acp', {
      id: 'app-message', text: 'APP FACT', kind: 'session-direct', deferredDispatch: true,
    })
    expect(injectEmdashPromptDetached.mock.calls[0]?.[2]).toEqual({ steerIfBusy: true, deferredDispatch: true })
  })

  // 发信方要排队:同一个 next-tool-call 家不带 steerIfBusy(会话机忙就排进队列),key 原样交给会话机的同键替换。
  // 变异对照:去掉 steerIfBusy 判据里的 `!opts?.delivery?.queue`,第一条红在 `{ steerIfBusy: true }`。
  it('does not steer a busy codex acp session when the sender asks to queue, and hands the key to the runtime queue', async () => {
    const { injectEmdashPromptDetached } = bridgeFor('codex')

    await emdashAgentRegistry.tryInjectSessionMessage('conv-codex-acp', {
      id: 'queued-1',
      text: 'PAPER 1',
      kind: 'session-direct',
      delivery: { queue: true },
    })
    await emdashAgentRegistry.tryInjectSessionMessage('conv-codex-acp', {
      id: 'queued-2',
      text: 'PAPER 2',
      kind: 'session-direct',
      delivery: { queue: true, coalesceKey: 'app:lens:paper' },
    })

    expect(injectEmdashPromptDetached.mock.calls.map((call) => call[2])).toEqual([
      undefined,
      { coalesceKey: 'app:lens:paper' },
    ])
  })

  it('attempts an undeclared family (kimi, idle-only) through detached admission without a timing flag', async () => {
    const { injectEmdashPromptDetached } = bridgeFor('kimi')

    await emdashAgentRegistry.tryInjectSessionMessage('conv-kimi-acp', {
      id: 'count-off-2',
      text: 'COUNTOFF 2',
      kind: 'session-direct',
    })

    expect(injectEmdashPromptDetached).toHaveBeenCalledTimes(1)
    expect(injectEmdashPromptDetached.mock.calls[0]?.[2]).toBeUndefined()
  })

  it('surfaces a queued-only detached result as loud failure', async () => {
    const { injectEmdashPromptDetached } = bridgeFor('kimi')
    injectEmdashPromptDetached.mockResolvedValueOnce({
      outcome: 'queued',
      completion: Promise.resolve(),
      turnId: '',
    })

    await expect(emdashAgentRegistry.tryInjectSessionMessage('conv-kimi-acp', {
      id: 'count-off-3',
      text: 'COUNTOFF 3',
      kind: 'session-direct',
    })).rejects.toThrow(/queued without an admission identity/)
  })

  it('returns a queued admission receipt when runtime supplies its request identity', async () => {
    const { injectEmdashPromptDetached } = bridgeFor('kimi')
    injectEmdashPromptDetached.mockResolvedValueOnce({
      outcome: 'queued',
      completion: Promise.resolve(),
      turnId: 'queued-request-1',
    })

    await expect(emdashAgentRegistry.tryInjectSessionMessage('conv-kimi-acp', {
      id: 'count-off-4',
      text: 'COUNTOFF 4',
      kind: 'session-direct',
    })).resolves.toMatchObject({ queued: true, turnId: 'queued-request-1' })
  })
})
