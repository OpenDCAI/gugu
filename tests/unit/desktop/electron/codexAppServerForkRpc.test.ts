import { describe, expect, it, vi } from 'vitest'
import {
  CodexAppServerSession,
  CodexAppServerRegistry,
  CodexTurnCompletionTracker,
  CodexTurnStartTracker,
  codexTurnCompletionStatus,
  codexTurnLifecycle,
  codexForkStartedEvent,
  codexForkRewritesHistory,
  openCodexThread,
  CODEX_INITIALIZE_PARAMS,
} from '../../../../apps/desktop/electron/sessionpage/codex-app-server-delivery'
import { normalizeGuguToolName } from '../../../../apps/desktop/electron/mcp/gugu-mcp-name.mjs'
describe('Codex Gugu tool naming', () => {
  it('accepts both basename and fully-qualified MCP names', () => {
    expect(normalizeGuguToolName('message_send')).toBe('message_send')
    expect(normalizeGuguToolName('mcp__gugu__message_send')).toBe('message_send')
    expect(normalizeGuguToolName('mcp__other__message_send')).toBe('mcp__other__message_send')
  })
})
describe('Codex app-server startup failure boundary (#2576)', () => {
  it('turns a missing codex executable into a rejected session start', async () => {
    const session = new CodexAppServerSession(
      `missing-codex-${Date.now()}`,
      '/definitely/missing/gugu-codex',
    )
    const failure = session.start('/tmp')
    await expect(failure).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(failure).rejects.toThrow('/definitely/missing/gugu-codex')
    await expect(failure).rejects.toThrow('安装 Codex CLI')
    await session.dispose()
  })
})
describe('Codex app-server delivery acceptance', () => {
  it('reports the registered session factual turn state per conversation (host recovery deferral)', () => {
    const registry = new CodexAppServerRegistry()
    const isTurnInFlight = vi.fn(() => true)
    registry.register('agent-1', {
      threadId: 'thread-1',
      // 已有 threadId = 已可投递:与真会话一致,订阅即回调。
      onThreadLive: (listener: () => void) => listener(),
      belongsToSession: (sessionId: string) => sessionId === 'conv-1',
      isTurnInFlight,
    } as unknown as CodexAppServerSession, 'codex')
    expect(registry.isSessionTurnInFlight('conv-1')).toBe(true)
    expect(registry.isSessionTurnInFlight('conv-2')).toBe(false)
    expect(isTurnInFlight).toHaveBeenCalledTimes(1)
  })
  it('returns false without calling deliver when the mapped control channel is not live', async () => {
    const registry = new CodexAppServerRegistry()
    const deliver = vi.fn(async () => ({ turnId: 'turn-1' }))
    registry.register('agent-1', {
      threadId: 'thread-1',
      // 已有 threadId = 已可投递:与真会话一致,订阅即回调。
      onThreadLive: (listener: () => void) => listener(),
      isLive: () => false,
      deliver,
    } as unknown as CodexAppServerSession, 'codex')
    await expect(registry.tryInjectMessage('thread-1', 'hello')).resolves.toBe(false)
    expect(deliver).not.toHaveBeenCalled()
  })
  it('keeps a live adapter error fail-loud', async () => {
    const registry = new CodexAppServerRegistry()
    registry.register('agent-1', {
      threadId: 'thread-1',
      // 已有 threadId = 已可投递:与真会话一致,订阅即回调。
      onThreadLive: (listener: () => void) => listener(),
      isLive: () => true,
      deliver: vi.fn(async () => { throw new Error('rpc rejected') }),
    } as unknown as CodexAppServerSession, 'codex')
    await expect(registry.tryInjectMessage('thread-1', 'hello')).rejects.toThrow('rpc rejected')
  })
  it('propagates the accepted turn id and its non-blocking completion', async () => {
    const registry = new CodexAppServerRegistry()
    const completion = Promise.resolve()
    const waitForTurnCompletion = vi.fn(() => completion)
    registry.register('agent-1', {
      threadId: 'thread-1',
      // 已有 threadId = 已可投递:与真会话一致,订阅即回调。
      onThreadLive: (listener: () => void) => listener(),
      isLive: () => true,
      deliver: vi.fn(async () => ({ turnId: 'turn-1' })),
      waitForTurnCompletion,
    } as unknown as CodexAppServerSession, 'codex')
    await expect(registry.tryInjectMessage('thread-1', 'hello')).resolves.toEqual({
      turnId: 'turn-1',
      completion,
    })
    expect(waitForTurnCompletion).toHaveBeenCalledWith('turn-1')
  })
  it('lets provisioning wait for the next injected turn to become live', async () => {
    const registry = new CodexAppServerRegistry()
    let resolveLive!: () => void
    const live = new Promise<void>((resolve) => {
      resolveLive = resolve
    })
    const waitForTurnLive = vi.fn(() => live)
    registry.register('agent-1', {
      threadId: 'thread-1',
      // 已有 threadId = 已可投递:与真会话一致,订阅即回调。
      onThreadLive: (listener: () => void) => listener(),
      isLive: () => true,
      deliver: vi.fn(async () => ({ turnId: 'turn-1' })),
      waitForTurnLive,
      waitForTurnCompletion: vi.fn(() => Promise.resolve()),
    } as unknown as CodexAppServerSession, 'codex')
    const waiting = registry.waitForNextInjectedTurnLive('thread-1')
    await expect(registry.tryInjectMessage('thread-1', 'hello')).resolves.toMatchObject({
      turnId: 'turn-1',
    })
    expect(waitForTurnLive).toHaveBeenCalledWith('turn-1')
    resolveLive()
    await expect(waiting).resolves.toBeUndefined()
  })
})
describe('Codex turn-scoped command context completion', () => {
  it('tracks factual activity until every started turn completes', () => {
    const tracker = new CodexTurnCompletionTracker(1_000)
    tracker.start('turn-a')
    tracker.start('turn-b')
    expect(tracker.isActive()).toBe(true)
    tracker.complete('turn-a')
    expect(tracker.isActive()).toBe(true)
    tracker.complete('turn-b', new Error('failed'))
    expect(tracker.isActive()).toBe(false)
  })
  it('keeps teardown pending while an active turn still has a completion waiter', async () => {
    const tracker = new CodexTurnCompletionTracker(1_000)
    tracker.start('turn-live')
    const completion = tracker.wait('turn-live')
    expect(tracker.hasPendingTurn()).toBe(true)
    tracker.complete('turn-live')
    await expect(completion).resolves.toBeUndefined()
    expect(tracker.hasPendingTurn()).toBe(false)
  })
  it('settles all waiters for the same steer turn on turn/completed', async () => {
    const tracker = new CodexTurnCompletionTracker(1_000)
    const first = tracker.wait('turn-active')
    const latest = tracker.wait('turn-active')
    expect(latest).toBe(first)
    tracker.complete('turn-active')
    await expect(first).resolves.toBeUndefined()
  })
  it('remembers a completion that races ahead of receipt propagation', async () => {
    const tracker = new CodexTurnCompletionTracker(1_000)
    tracker.complete('turn-fast')
    await expect(tracker.wait('turn-fast')).resolves.toBeUndefined()
  })
  it('rejects a failed turn even when the error notification races ahead of receipt propagation', async () => {
    const tracker = new CodexTurnCompletionTracker(1_000)
    tracker.complete('turn-failed', new Error('provider turn failed'))
    await expect(tracker.wait('turn-failed')).rejects.toThrow('provider turn failed')
  })
  it('rejects loudly when turn/completed never arrives', async () => {
    vi.useFakeTimers()
    try {
      const tracker = new CodexTurnCompletionTracker(25)
      const completion = tracker.wait('turn-lost')
      const rejection = expect(completion).rejects.toThrow(
        'turn turn-lost did not emit turn/completed within 25ms',
      )
      await vi.advanceTimersByTimeAsync(25)
      await rejection
      expect(tracker.isActive()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
  it('re-arms completion waiters after a host suspend/resume boundary', async () => {
    vi.useFakeTimers()
    try {
      const tracker = new CodexTurnCompletionTracker(25)
      const completion = tracker.wait('turn-suspended')
      await vi.advanceTimersByTimeAsync(24)
      tracker.resume()
      await vi.advanceTimersByTimeAsync(24)
      let settled = false
      void completion.then(() => { settled = true }, () => { settled = true })
      await Promise.resolve()
      expect(settled).toBe(false)
      tracker.complete('turn-suspended')
      await expect(completion).resolves.toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
  it('reconciles a persisted terminal turn without borrowing another turn', () => {
    expect(codexTurnCompletionStatus({
      thread: {
        id: 'thread-1',
        turns: [{ id: 'turn-1', status: 'completed' }],
      },
    }, 'thread-1', 'turn-1')).toBe('completed')
    expect(codexTurnCompletionStatus({
      thread: {
        id: 'thread-1',
        turns: [{ id: 'turn-2', status: 'completed' }],
      },
    }, 'thread-1', 'turn-1')).toBe('unknown')
    expect(codexTurnCompletionStatus({
      thread: {
        id: 'other-thread',
        turns: [{ id: 'turn-1', status: 'completed' }],
      },
    }, 'thread-1', 'turn-1')).toBe('unknown')
    expect(codexTurnCompletionStatus({
      id: 'thread-1',
      turns: [{ id: 'turn-1', status: 'failed' }],
    }, 'thread-1', 'turn-1')).toBe('failed')
  })
  it('resolves a session completion after the notification timeout when the exact turn is persisted', async () => {
    vi.useFakeTimers()
    try {
      const session = new CodexAppServerSession('reconcile-session', '/unused-codex', undefined, {
        turnCompletionTimeoutMs: 25,
      })
      const internals = session as unknown as {
        client: { rpc: (method: string, params: unknown) => Promise<unknown> }
        threadId: string | null
        turnCompletions: CodexTurnCompletionTracker
      }
      internals.threadId = 'thread-1'
      internals.turnCompletions.start('turn-1')
      internals.client = {
        rpc: vi.fn(async () => ({
          thread: {
            id: 'thread-1',
            turns: [{ id: 'turn-1', status: 'completed' }],
          },
        })),
      }
      const completion = session.waitForTurnCompletion('turn-1')
      await vi.advanceTimersByTimeAsync(25)
      await expect(completion).resolves.toBeUndefined()
      expect(internals.client.rpc).toHaveBeenCalledWith('thread/read', {
        threadId: 'thread-1',
        includeTurns: true,
      })
    } finally {
      vi.useRealTimers()
    }
  })
})
describe('Codex app-server disposal boundary', () => {
  function makeSession(): {
    session: CodexAppServerSession
    tracker: CodexTurnCompletionTracker
  } {
    const session = new CodexAppServerSession('dispose-test', '/unused-codex')
    const internals = session as unknown as {
      client: { close: () => void }
      turnCompletions: CodexTurnCompletionTracker
    }
    internals.client = { close: vi.fn() }
    return { session, tracker: internals.turnCompletions }
  }
  it('waits for an in-flight completion before rejecting or resolving dispose', async () => {
    const { session, tracker } = makeSession()
    tracker.start('turn-live')
    const completion = tracker.wait('turn-live')
    let disposed = false
    const dispose = session.dispose().then(() => {
      disposed = true
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(disposed).toBe(false)
    tracker.complete('turn-live')
    await expect(completion).resolves.toBeUndefined()
    await expect(dispose).resolves.toBeUndefined()
    expect(disposed).toBe(true)
  })
  it('interrupts active turns before waiting for teardown completion', async () => {
    const { session, tracker } = makeSession()
    const rpc = vi.fn(async () => ({}))
    const internals = session as unknown as {
      client: { rpc: typeof rpc; close: () => void }
      threadId: string | null
    }
    internals.client = { rpc, close: vi.fn() }
    internals.threadId = 'thread-live'
    tracker.start('turn-live')
    const dispose = session.dispose()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(rpc).toHaveBeenCalledWith('turn/interrupt', {
      threadId: 'thread-live',
      turnId: 'turn-live',
    })
    tracker.complete('turn-live')
    await expect(dispose).resolves.toBeUndefined()
  })
  it('rejects the waiter and dispose with the named teardown timeout', async () => {
    vi.useFakeTimers()
    try {
      const { session, tracker } = makeSession()
      tracker.start('turn-timeout')
      const completion = tracker.wait('turn-timeout')
      const completionError = expect(completion).rejects.toThrow(
        'codex app-server teardown timed out waiting for in-flight turn completion after 30000ms',
      )
      const dispose = session.dispose()
      const disposeError = expect(dispose).rejects.toThrow(
        'codex app-server teardown timed out waiting for in-flight turn completion after 30000ms',
      )
      await vi.advanceTimersByTimeAsync(30_000)
      await completionError
      await disposeError
    } finally {
      vi.useRealTimers()
    }
  })
})
describe('Codex turn start tracking', () => {
  it('remembers turn/started that arrives before the waiter is installed', async () => {
    const tracker = new CodexTurnStartTracker()
    tracker.start('turn-fast')
    await expect(tracker.wait('turn-fast', 25)).resolves.toBeUndefined()
  })
  it('fails loudly when turn/started never arrives', async () => {
    vi.useFakeTimers()
    try {
      const tracker = new CodexTurnStartTracker()
      const started = tracker.wait('turn-lost', 25)
      const rejection = expect(started).rejects.toThrow(
        'turn turn-lost did not emit turn/started within 25ms',
      )
      await vi.advanceTimersByTimeAsync(25)
      await rejection
    } finally {
      vi.useRealTimers()
    }
  })
})
describe('Codex app-server thread creation', () => {
  it('recognizes a user fork but excludes subagent lineage', () => {
    expect(codexForkStartedEvent({
      method: 'thread/started',
      params: {
        thread: {
          id: 'child-thread',
          forkedFromId: 'parent-thread',
          parentThreadId: null,
        },
      },
    })).toEqual({
      threadId: 'child-thread',
      forkedFromId: 'parent-thread',
      parentThreadId: null,
    })
    expect(codexForkStartedEvent({
      method: 'thread/started',
      params: {
        thread: {
          id: 'subagent-thread',
          forkedFromId: 'parent-thread',
          parentThreadId: 'parent-thread',
        },
      },
    })).toEqual({
      threadId: 'subagent-thread',
      forkedFromId: 'parent-thread',
      parentThreadId: 'parent-thread',
    })
  })

  it('distinguishes a truncated or rewritten rewind from an explicit full-history fork', () => {
    const parent = { thread: { turns: [{ id: 'turn-1' }, { id: 'turn-2' }] } }
    expect(codexForkRewritesHistory(parent, {
      thread: { turns: [{ id: 'turn-1' }] },
    })).toBe(true)
    expect(codexForkRewritesHistory(parent, {
      thread: { turns: [{ id: 'turn-1' }, { id: 'turn-new' }] },
    })).toBe(true)
    expect(codexForkRewritesHistory(parent, {
      thread: { turns: [{ id: 'turn-1' }, { id: 'turn-2' }] },
    })).toBe(false)
  })

  it('adopts a rewritten TUI thread and persists the new provider id', async () => {
    const onThreadIdChanged = vi.fn(async () => undefined)
    const session = new CodexAppServerSession('rewind-session', '/unused-codex', undefined, {
      sessionId: 'conversation-1',
      onThreadIdChanged,
    })
    const rpc = vi.fn(async (_method: string, params: { threadId: string }) => ({
      thread: {
        id: params.threadId,
        turns: params.threadId === 'parent-thread'
          ? [{ id: 'turn-1' }, { id: 'turn-2' }]
          : [{ id: 'turn-1' }],
      },
    }))
    const internals = session as unknown as {
      client: { rpc: typeof rpc }
      threadId: string | null
      reconcileThreadFork: (childThreadId: string, parentThreadId: string) => Promise<void>
    }
    internals.client = { rpc }
    internals.threadId = 'parent-thread'

    await internals.reconcileThreadFork('child-thread', 'parent-thread')

    expect(session.threadId).toBe('child-thread')
    expect(onThreadIdChanged).toHaveBeenCalledWith('child-thread')
    expect(rpc).toHaveBeenNthCalledWith(1, 'thread/read', {
      threadId: 'parent-thread',
      includeTurns: true,
    })
    expect(rpc).toHaveBeenNthCalledWith(2, 'thread/read', {
      threadId: 'child-thread',
      includeTurns: true,
    })
  })

  it('leaves a full-history explicit fork for rollout capture', async () => {
    const onThreadIdChanged = vi.fn(async () => undefined)
    const session = new CodexAppServerSession('explicit-fork-session', '/unused-codex', undefined, {
      sessionId: 'conversation-2',
      onThreadIdChanged,
    })
    const internals = session as unknown as {
      client: { rpc: (method: string, params: unknown) => Promise<unknown> }
      threadId: string | null
      reconcileThreadFork: (childThreadId: string, parentThreadId: string) => Promise<void>
    }
    internals.client = {
      rpc: async (_method, params) => ({
        thread: {
          id: (params as { threadId: string }).threadId,
          turns: [{ id: 'turn-1' }, { id: 'turn-2' }],
        },
      }),
    }
    internals.threadId = 'parent-thread'

    await internals.reconcileThreadFork('child-thread', 'parent-thread')

    expect(session.threadId).toBe('parent-thread')
    expect(onThreadIdChanged).not.toHaveBeenCalled()
  })

  it('uses thread/fork with the provider session id for a forked conversation', async () => {
    const rpc = vi.fn(async (_method: string, _params: unknown) => ({ thread: { id: 'child-thread' } }))
    await expect(
      openCodexThread({ rpc }, '/workspace/task', 'parent-thread', undefined, 'identity', {
        'mcp_servers.gugu.url': 'http://127.0.0.1:1/mcp',
        'mcp_servers.gugu.enabled': false,
      }),
    ).resolves.toBe('child-thread')
    expect(rpc).toHaveBeenCalledWith('thread/fork', {
      threadId: 'parent-thread',
      cwd: '/workspace/task',
      developerInstructions: 'identity',
      config: {
        'mcp_servers.gugu.url': 'http://127.0.0.1:1/mcp',
        'mcp_servers.gugu.enabled': false,
      },
    })
    expect(rpc.mock.calls[0][1]).not.toHaveProperty('dynamicTools')
  })
  it('keeps ordinary conversations on thread/start', async () => {
    const rpc = vi.fn(async (_method: string, _params: unknown) => ({ thread: { id: 'fresh-thread' } }))
    await expect(
      openCodexThread({ rpc }, '/workspace/task', undefined, undefined, 'identity', {
        'mcp_servers.gugu.url': 'http://127.0.0.1:1/mcp',
      }),
    ).resolves.toBe('fresh-thread')
    expect(rpc).toHaveBeenCalledWith('thread/start', {
      cwd: '/workspace/task',
      developerInstructions: 'identity',
      config: { 'mcp_servers.gugu.url': 'http://127.0.0.1:1/mcp' },
    })
    expect(rpc.mock.calls[0][1]).not.toHaveProperty('dynamicTools')
  })
  it('resumes the persisted provider thread after reopening', async () => {
    const rpc = vi.fn(async (_method: string, _params: unknown) => ({ thread: { id: 'existing-thread' } }))
    await expect(
      openCodexThread({ rpc }, '/workspace/task', undefined, 'existing-thread', undefined, {
        'mcp_servers.gugu.url': 'http://127.0.0.1:1/mcp',
      }),
    ).resolves.toBe('existing-thread')
    expect(rpc).toHaveBeenCalledWith('thread/resume', {
      threadId: 'existing-thread',
      config: { 'mcp_servers.gugu.url': 'http://127.0.0.1:1/mcp' },
    })
    expect(rpc.mock.calls[0][1]).not.toHaveProperty('dynamicTools')
  })
})
describe.each(['start', 'resume', 'fork'] as const)('Codex thread/%s permissions (#5950)', (operation) => {
  it.each([
    ['read-only', 'never', 'read-only'],
    ['edit', 'on-request', 'workspace-write'],
    ['full-access', 'never', 'danger-full-access'],
  ] as const)('applies the saved %s tier without changing MCP configuration', async (_mode, approvalPolicy, sandbox) => {
    const rpc = vi.fn(async (_method: string, _params: unknown) => ({ thread: { id: 'opened-thread' } }))
    const config = { 'mcp_servers.gugu.url': 'http://127.0.0.1:1/mcp' }

    await expect(openCodexThread(
      { rpc }, '/workspace/task',
      operation === 'fork' ? 'parent-thread' : undefined,
      operation === 'resume' ? 'existing-thread' : undefined,
      'identity', config, { approvalPolicy, sandbox },
    )).resolves.toBe('opened-thread')

    expect(rpc).toHaveBeenCalledExactlyOnceWith(`thread/${operation}`, {
      ...(operation === 'resume'
        ? { threadId: 'existing-thread' }
        : { cwd: '/workspace/task', developerInstructions: 'identity' }),
      ...(operation === 'fork' ? { threadId: 'parent-thread' } : {}),
      config,
      approvalPolicy,
      sandbox,
    })
  })

  it('leaves unspecified permissions to Codex without granting full access', async () => {
    const rpc = vi.fn(async (_method: string, _params: unknown) => ({ thread: { id: 'opened-thread' } }))
    await openCodexThread(
      { rpc }, '/workspace/task',
      operation === 'fork' ? 'parent-thread' : undefined,
      operation === 'resume' ? 'existing-thread' : undefined,
    )
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc.mock.calls[0][1]).not.toHaveProperty('approvalPolicy')
    expect(rpc.mock.calls[0][1]).not.toHaveProperty('sandbox')
  })
})
describe('Codex app-server turn lifecycle', () => {
  it('preserves the upstream failure message on the live completion path', async () => {
    const session = new CodexAppServerSession('agent-capacity', '/unused/codex')
    let notify!: (message: unknown) => void
    const internals = session as unknown as {
      threadId: string
      subscribeEvents(client: unknown): void
    }
    internals.threadId = 'thread-capacity'
    internals.subscribeEvents({ onEvent: (handler: typeof notify) => { notify = handler } })
    const reason = 'Selected model is at capacity. Please try a different model.'
    notify({ method: 'turn/completed', params: {
      threadId: 'thread-capacity', turn: { id: 'turn-capacity', status: 'failed', error: { message: reason } },
    } })
    await expect(session.waitForTurnCompletion('turn-capacity')).rejects.toThrow(reason)
  })

  it('maps matching notifications and ignores unrelated ones', () => {
    expect(
      codexTurnLifecycle(
        { method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } },
        'thread-1',
      ),
    ).toEqual({ type: 'start' })
    expect(
      codexTurnLifecycle(
        {
          method: 'turn/completed',
          params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
        },
        'thread-1',
      ),
    ).toEqual({ type: 'stop' })
    expect(
      codexTurnLifecycle(
        {
          method: 'turn/completed',
          params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'failed' } },
        },
        'thread-1',
      ),
    ).toEqual({ type: 'error' })
    expect(
      codexTurnLifecycle(
        { method: 'turn/completed', params: { threadId: 'thread-2' } },
        'thread-1',
      ),
    ).toBeNull()
    expect(
      codexTurnLifecycle(
        { method: 'item/completed', params: { threadId: 'thread-1' } },
        'thread-1',
      ),
    ).toBeNull()
  })
})
describe('#3907 · task-TUI does not advertise dynamic tools', () => {
  const openMethods = [
    ['thread/start', undefined, undefined],
    ['thread/resume', undefined, 'resume-thread'],
    ['thread/fork', 'parent-thread', undefined],
  ] as const
  it.each(openMethods)('%s omits the unavailable dynamic-tool declaration', async (method, fork, resume) => {
    const rpc = vi.fn().mockResolvedValue({ thread: { id: 't' } })
    await openCodexThread({ rpc }, '/workspace/task', fork, resume, undefined)
    const params = rpc.mock.calls[0][1] as { dynamicTools?: Array<{ name: string }> }
    expect(rpc.mock.calls[0][0]).toBe(method)
    expect(params).not.toHaveProperty('dynamicTools')
  })
})
describe('#3907 · task-TUI dynamic-tool declaration gate', () => {
  it('does not send dynamicTools on thread start even though the app-server handshake supports the protocol', async () => {
    const rpc = vi.fn().mockResolvedValue({ thread: { id: 't' } })
    await openCodexThread({ rpc }, '/workspace/task', undefined, undefined, undefined)
    const params = rpc.mock.calls[0][1] as { dynamicTools?: unknown[] }
    expect(params).not.toHaveProperty('dynamicTools')
    expect(
      (CODEX_INITIALIZE_PARAMS.capabilities as { experimentalApi?: boolean }).experimentalApi,
      'the handshake capability is independent from the task-TUI tool declaration',
    ).toBe(true)
  })
})
describe('#3961 CodexTurnCompletionTracker.isActive 的上界', () => {
  it('被 start 但没人 wait 的回合,超过完成预算后不再算在飞', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-08-22T00:00:00.000Z'))
      const tracker = new CodexTurnCompletionTracker(1_000)
      tracker.start('orphan-turn')            // 只 start,不 wait —— 用户在 TUI 里自己起的那种
      expect(tracker.isActive(), '预算内仍算在飞').toBe(true)
      vi.setSystemTime(Date.now() + 1_001)
      expect(
        tracker.isActive(),
        '结算通知丢了也必须有上界,否则 presence 会永远说它在跑',
      ).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
  it('预算边界之前仍算在飞 —— 否则「有上界」会退化成「随时可能不算」', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-08-22T00:00:00.000Z'))
      const tracker = new CodexTurnCompletionTracker(1_000)
      tracker.start('t')
      vi.setSystemTime(Date.now() + 999)
      expect(tracker.isActive()).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
  it('正常结算的回合立刻不在飞,不必等上界', () => {
    const tracker = new CodexTurnCompletionTracker(60_000)
    tracker.start('t')
    expect(tracker.isActive()).toBe(true)
    tracker.complete('t')
    expect(tracker.isActive(), '上界是兜底,不是唯一出口').toBe(false)
  })
})
