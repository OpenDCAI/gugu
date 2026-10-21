// @vitest-environment jsdom
import { AuthRetryableFetchError, AuthSessionMissingError, type Session, type User } from '@supabase/supabase-js'
import type { EventEmitter } from 'node:events'
import process from 'node:process'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { deferred } from '../../../support/testHarness'
import {
  SessionCoordinator,
  type SessionCoordinatorStatus,
  type SessionCoordinatorDeps,
} from '../../../../apps/desktop/src/lib/sessionCoordinator'
import type { AuthUser } from '../../../../apps/desktop/src/store/auth'
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
function session(id = 'user-a'): Session {
  return {
    access_token: `access-${id}`,
    refresh_token: `refresh-${id}`,
    token_type: 'bearer',
    expires_in: 3600,
    user: {
      id,
      aud: 'authenticated',
      role: 'authenticated',
      email: `${id}@example.test`,
      user_metadata: { nickname: `Session ${id}`, avatar_url: 'legacy-avatar.svg' },
      app_metadata: {},
      created_at: '2026-01-01T00:00:00.000Z',
    },
  } as Session
}
function profile(id = 'user-a'): AuthUser {
  return { id, email: `${id}@example.test`, nickname: `Canonical ${id}`, bio: null }
}
function harness(overrides: Partial<SessionCoordinatorDeps> = {}) {
  let authListener: (event: string, value: Session | null) => void = () => {}
  let foregroundListener = () => {}
  let foregroundError = (_error: unknown) => {}
  const foregroundUnsubscribe = vi.fn(() => { foregroundListener = () => {} })
  const deps: SessionCoordinatorDeps = {
    getSession: vi.fn(() => new Promise<{ data: { session: Session | null }; error: unknown }>(() => {})),
    getUser: vi.fn(async () => ({ data: { user: session().user }, error: null })),
    refreshSession: vi.fn(async () => ({ data: { session: session() }, error: null })),
    restoreSession: vi.fn(async ({ access_token }) => ({
      data: { session: session(access_token.replace(/^access-/, '')) }, error: null,
    })),
    onAuthStateChange: vi.fn((listener) => {
      authListener = listener
      return { data: { subscription: { unsubscribe: vi.fn() } } }
    }),
    signOut: vi.fn(async () => ({ error: null })),
    hydrateUser: vi.fn(async (user: User) => profile(user.id)),
    publishSession: vi.fn(),
    writeMirror: vi.fn(async () => {}),
    clearMirror: vi.fn(async () => {}),
    getPersistedSessionState: vi.fn(() => ({ bootCandidate: null, warning: null })),
    commitPersistedSession: vi.fn(async () => {}),
    clearPersistedSession: vi.fn(async () => {}),
    subscribeAppForeground: vi.fn((listener, onError) => {
      foregroundListener = listener
      foregroundError = onError
      return foregroundUnsubscribe
    }),
    ...overrides,
  }
  const coordinator = new SessionCoordinator(deps)
  return {
    coordinator,
    deps,
    login: (value: Session) => coordinator.acceptInteractiveSession(coordinator.beginInteractiveLogin(), value),
    fire: (event: string, value: Session | null) => authListener(event, value),
    foreground: () => foregroundListener(),
    foregroundError: (error: unknown) => foregroundError(error),
    foregroundUnsubscribe,
  }
}
describe('SessionCoordinator', () => {
  beforeEach(() => vi.useRealTimers())
  it('keeps startup user validation on the request-only auth overload', async () => {
    const getUser = vi.fn<SessionCoordinatorDeps['getUser']>(async (accessToken) => {
      if (!accessToken) throw new Error('startup validation must provide the session access token')
      return { data: { user: session().user }, error: null }
    })
    const h = harness({ getUser })
    h.coordinator.start()
    h.fire('INITIAL_SESSION', session())
    await flush()
    expect(getUser).toHaveBeenCalledWith('access-user-a')
    expect(h.coordinator.getSnapshot()).toMatchObject({
      status: 'authenticated',
      user: { id: 'user-a' },
    })
  })
  it.each([
    ['SDK null', null],
    ['SDK transient error', new TypeError('offline')],
  ])('retains the exact boot candidate degraded when %s cannot restore it', async (_name, error) => {
    const candidate = session('user-b')
    const h = harness({
      getSession: vi.fn(async () => ({ data: { session: null }, error })),
      getPersistedSessionState: vi.fn(() => ({ bootCandidate: candidate, warning: null })),
    })
    h.coordinator.start()
    await flush()
    expect(h.coordinator.getSnapshot()).toMatchObject({
      status: 'degraded',
      session: { user: { id: 'user-b' } },
      user: { id: 'user-b' },
    })
    expect(h.deps.clearPersistedSession).not.toHaveBeenCalled()
  })
  // #7172 第二天打开,刷新令牌已死(在别处全局登出、改了密码):启动恢复与续期同一个判断 —— 永久错误落登录页、
  // 清掉那份会话、不再重试;断网、5xx 照旧降级重试,绝不登出。
  it('expires a boot candidate whose refresh token the server no longer knows, and stops retrying it', async () => {
    vi.useFakeTimers()
    const candidate = session('user-b')
    const getSession = vi.fn(async () => ({
      data: { session: null },
      error: { name: 'AuthApiError', status: 400, code: 'refresh_token_not_found', message: 'Invalid Refresh Token: Refresh Token Not Found' },
    }))
    const h = harness({ getSession, getPersistedSessionState: vi.fn(() => ({ bootCandidate: candidate, warning: null })) })
    // 已登录界面一瞬都不该挂上:它挂上就会发请求,随即被登出中断,在登录页上报错。
    const shownUsers: (string | null)[] = []
    h.coordinator.subscribe(() => shownUsers.push(h.coordinator.getSnapshot().user?.id ?? null))
    h.coordinator.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.coordinator.getSnapshot()).toMatchObject({ status: 'expired', session: null, user: null })
    expect(shownUsers.length).toBeGreaterThan(0)
    expect(shownUsers).not.toContain('user-b')
    expect(h.deps.clearPersistedSession).toHaveBeenCalledOnce()
    expect(h.deps.clearPersistedSession).toHaveBeenCalledWith(candidate, expect.any(AbortSignal))
    expect(h.deps.publishSession).toHaveBeenLastCalledWith('RESTORE_EXPIRED', null)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(getSession).toHaveBeenCalledOnce()
  })
  it.each([
    ['the network is down', new AuthRetryableFetchError('Failed to fetch', 0)],
    ['the auth server answers 5xx', { name: 'AuthApiError', status: 500, code: 'unexpected_failure', message: 'Internal Server Error' }],
  ])('keeps a boot candidate degraded while %s, never signs out, and restores once it is back', async (_name, error) => {
    vi.useFakeTimers()
    const candidate = session('user-b')
    const getSession = vi.fn()
      .mockResolvedValueOnce({ data: { session: null }, error })
      .mockResolvedValueOnce({ data: { session: null }, error })
      .mockResolvedValueOnce({ data: { session: candidate }, error: null })
    const h = harness({
      getSession,
      getUser: vi.fn(async () => ({ data: { user: candidate.user }, error: null })),
      getPersistedSessionState: vi.fn(() => ({ bootCandidate: candidate, warning: null })),
    })
    const statuses: SessionCoordinatorStatus[] = []
    h.coordinator.subscribe(() => statuses.push(h.coordinator.getSnapshot().status))
    h.coordinator.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.coordinator.getSnapshot()).toMatchObject({ status: 'degraded', session: { user: { id: 'user-b' } }, user: { id: 'user-b' } })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(getSession).toHaveBeenCalledTimes(2)
    expect(h.coordinator.getSnapshot()).toMatchObject({ status: 'degraded', user: { id: 'user-b' } })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(getSession).toHaveBeenCalledTimes(3)
    expect(h.coordinator.getSnapshot()).toMatchObject({ status: 'authenticated', user: { id: 'user-b' } })
    expect(statuses).not.toContain('expired')
    expect(statuses).not.toContain('anonymous')
    expect(h.deps.clearPersistedSession).not.toHaveBeenCalled()
  })
  it('restores projected B after A to B commits, and clears A across terminal restart', async () => {
    let persisted: Session | null = session('user-a')
    const persistedState = () => ({ bootCandidate: persisted, warning: null })
    const first = harness({
      getPersistedSessionState: vi.fn(persistedState),
      commitPersistedSession: vi.fn(async (value) => { persisted = value }),
      clearPersistedSession: vi.fn(async () => { persisted = null }),
      getUser: vi.fn()
        .mockResolvedValueOnce({ data: { user: session('user-a').user }, error: null })
        .mockResolvedValueOnce({ data: { user: session('user-b').user }, error: null }),
    })
    const stopFirst = first.coordinator.start()
    await first.login(session('user-a'))
    await first.login(session('user-b'))
    stopFirst()
    const restartedB = harness({
      getSession: vi.fn(async () => ({ data: { session: null }, error: null })),
      getPersistedSessionState: vi.fn(persistedState),
      clearPersistedSession: vi.fn(async () => { persisted = null }),
    })
    restartedB.coordinator.start()
    await flush()
    expect(restartedB.coordinator.getSnapshot()).toMatchObject({ status: 'degraded', user: { id: 'user-b' } })
    await restartedB.coordinator.logout()
    const anonymous = harness({
      getSession: vi.fn(async () => ({ data: { session: null }, error: null })),
      getPersistedSessionState: vi.fn(() => ({ bootCandidate: null, warning: null })),
    })
    anonymous.coordinator.start()
    await flush()
    expect(anonymous.coordinator.getSnapshot()).toMatchObject({ status: 'anonymous', session: null, user: null })
  })
  it('does not publish cleanup degradation while entering anonymous without a session', async () => {
    const h = harness({
      getSession: vi.fn(async () => ({ data: { session: null }, error: null })),
      getPersistedSessionState: vi.fn(() => ({ bootCandidate: null, warning: null })),
    })
    const statuses: SessionCoordinatorStatus[] = []
    h.coordinator.subscribe(() => statuses.push(h.coordinator.getSnapshot().status))
    h.coordinator.start()
    await flush()
    expect(statuses).not.toContain('degraded')
    expect(h.coordinator.getSnapshot()).toMatchObject({ status: 'anonymous', error: null })
  })
  it('transient-auth-failure-never-falls-back-to-logout: keeps the session shell degraded, then recovers', async () => {
    vi.useFakeTimers()
    const getUser = vi.fn()
      .mockResolvedValueOnce({
        data: { user: null },
        error: new AuthRetryableFetchError('Failed to fetch', 0),
      })
      .mockResolvedValueOnce({ data: { user: session().user }, error: null })
    const h = harness({ getUser })
    h.coordinator.start()
    h.fire('INITIAL_SESSION', session())
    await vi.advanceTimersByTimeAsync(0)
    expect(h.coordinator.getSnapshot()).toMatchObject({
      status: 'degraded',
      session: { access_token: 'access-user-a' },
      user: { id: 'user-a', nickname: '' },
    })
    expect(h.deps.clearMirror).not.toHaveBeenCalled()
    expect(h.deps.writeMirror).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(h.coordinator.getSnapshot()).toMatchObject({
      status: 'authenticated',
      user: { id: 'user-a', nickname: 'Canonical user-a' },
    })
  })
  it('coalesces a foreground-origin validation burst without a trailing run', async () => {
    vi.useFakeTimers()
    const validation = deferred<{ data: { user: User | null }; error: unknown }>()
    const getUser = vi.fn<SessionCoordinatorDeps['getUser']>(async () => ({
      data: { user: session().user }, error: null,
    }))
    const h = harness({ getUser })
    const stop = h.coordinator.start()
    await h.login(session())
    getUser.mockClear()
    getUser.mockReturnValueOnce(validation.promise)
    h.foreground()
    h.foreground()
    expect(getUser).toHaveBeenCalledOnce()
    validation.resolve({ data: { user: session().user }, error: null })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(getUser).toHaveBeenCalledOnce()
    expect(h.coordinator.getSnapshot()).toMatchObject({ status: 'authenticated', user: { id: 'user-a' } })
    stop()
    h.foreground()
    expect(getUser).toHaveBeenCalledOnce()
    expect(h.foregroundUnsubscribe).toHaveBeenCalledOnce()
  })
  it.each(['success', 'retryable failure', 'rejection'])(
    'runs one trailing foreground validation after the boot flight settles: %s',
    async (settlement) => {
      vi.useFakeTimers()
      const unhandled: unknown[] = []
      const processEvents = process as unknown as EventEmitter
      const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
      processEvents.on('unhandledRejection', onUnhandled)
      const consoleError = settlement === 'rejection'
        ? vi.spyOn(console, 'error').mockImplementationOnce(() => { throw new Error('degraded observer rejected') })
        : null
      const active = deferred<{ data: { user: User | null }; error: unknown }>()
      const trailing = deferred<{ data: { user: User | null }; error: unknown }>()
      const tokens: string[] = []
      const getUser = vi.fn((token: string) => {
        tokens.push(token)
        return tokens.length === 1
          ? active.promise
          : tokens.length === 2
            ? trailing.promise
          : Promise.resolve({ data: { user: session().user }, error: null })
      })
      const h = harness({
        getSession: vi.fn(async () => ({ data: { session: session() }, error: null })),
        getUser,
      })
      try {
        h.coordinator.start()
        await vi.advanceTimersByTimeAsync(0)
        expect(h.coordinator.getSnapshot()).toMatchObject({
          status: 'authenticated',
          session: { user: { id: 'user-a' } },
          user: { id: 'user-a', nickname: '' },
        })
        h.foreground()
        h.foreground()
        expect(tokens).toEqual(['access-user-a'])
        if (settlement === 'rejection') active.reject(new Error('boot validation rejected'))
        else active.resolve(settlement === 'success'
          ? { data: { user: session().user }, error: null }
          : { data: { user: null }, error: new AuthRetryableFetchError('offline', 0) })
        await vi.advanceTimersByTimeAsync(0)
        expect(tokens).toEqual(['access-user-a', 'access-user-a'])
        h.foreground()
        h.foreground()
        expect(tokens).toHaveLength(2)
        trailing.resolve({ data: { user: session().user }, error: null })
        await vi.advanceTimersByTimeAsync(0)
        expect(h.coordinator.getSnapshot()).toMatchObject({
          status: 'authenticated',
          session: { user: { id: 'user-a' } },
          user: { id: 'user-a', nickname: 'Canonical user-a' },
        })
        h.foreground()
        await vi.advanceTimersByTimeAsync(0)
        expect(tokens).toHaveLength(3)
        await vi.advanceTimersByTimeAsync(1_000)
        expect(tokens).toHaveLength(3)
        expect(unhandled).toEqual([])
      } finally {
        consoleError?.mockRestore()
        processEvents.off('unhandledRejection', onUnhandled)
      }
    },
  )
  it('resets the old validate retry before a trailing foreground request', async () => {
    vi.useFakeTimers()
    const automatic = deferred<{ data: { user: User | null }; error: unknown }>()
    const trailing = deferred<{ data: { user: User | null }; error: unknown }>()
    const getUser = vi.fn()
      .mockReturnValueOnce(automatic.promise)
      .mockReturnValueOnce(trailing.promise)
      .mockResolvedValue({ data: { user: session().user }, error: null })
    const h = harness({
      getSession: vi.fn(async () => ({ data: { session: session() }, error: null })),
      getUser,
    })
    h.coordinator.start()
    await vi.advanceTimersByTimeAsync(0)
    h.foreground()
    automatic.resolve({ data: { user: null }, error: new AuthRetryableFetchError('offline', 0) })
    await vi.advanceTimersByTimeAsync(0)
    expect(getUser).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(getUser).toHaveBeenCalledTimes(2)
    trailing.resolve({ data: { user: null }, error: new AuthRetryableFetchError('offline', 0) })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(999)
    expect(getUser).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(getUser).toHaveBeenCalledTimes(3)
  })
  it('surfaces foreground registration failure while active and ignores it after stop', async () => {
    const h = harness()
    const stop = h.coordinator.start()
    await h.login(session())
    h.foregroundError(new Error('registration failed'))
    expect(h.coordinator.getSnapshot()).toMatchObject({
      status: 'degraded',
      error: { message: 'registration failed' },
    })
    stop()
    h.foregroundError(new Error('late registration failure'))
    expect(h.coordinator.getSnapshot().error?.message).toBe('registration failed')
  })
  it('joins an immediate foreground validation from the existing retry timer', async () => {
    vi.useFakeTimers()
    const validation = deferred<{ data: { user: User | null }; error: unknown }>()
    const getUser = vi.fn()
      .mockResolvedValueOnce({ data: { user: session().user }, error: null })
      .mockResolvedValueOnce({ data: { user: null }, error: new AuthRetryableFetchError('offline', 0) })
      .mockReturnValueOnce(validation.promise)
    const h = harness({ getUser })
    h.coordinator.start()
    await h.login(session())
    h.foreground()
    await vi.advanceTimersByTimeAsync(0)
    h.foreground()
    expect(getUser).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(getUser).toHaveBeenCalledTimes(3)
    validation.resolve({ data: { user: session().user }, error: null })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.coordinator.getSnapshot().status).toBe('authenticated')
  })
  it('routes near-expiry foreground events through the generation-scoped refresh single-flight', async () => {
    const refresh = deferred<{ data: { session: Session | null }; error: unknown }>()
    const refreshSession = vi.fn(() => refresh.promise)
    const expiring = session()
    expiring.expires_at = Math.floor(Date.now() / 1_000) + 30
    const h = harness({ refreshSession })
    h.coordinator.start()
    await h.login(expiring)
    h.foreground()
    h.foreground()
    expect(refreshSession).toHaveBeenCalledOnce()
    refresh.resolve({ data: { session: expiring }, error: null })
    await flush()
    expect(h.coordinator.getSnapshot().status).toBe('authenticated')
  })
  it('owns foreground refresh and persisted-commit rejection without unhandled work', async () => {
    const unhandled: unknown[] = []
    const processEvents = process as unknown as EventEmitter
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
    processEvents.on('unhandledRejection', onUnhandled)
    try {
      const expiring = session()
      expiring.expires_at = Math.floor(Date.now() / 1_000) + 30
      const recovered = session()
      recovered.expires_at = Math.floor(Date.now() / 1_000) + 3_600
      const transportRefresh = vi.fn()
        .mockRejectedValueOnce(new Error('refresh transport rejected'))
        .mockResolvedValueOnce({ data: { session: recovered }, error: null })
      const transport = harness({ refreshSession: transportRefresh })
      transport.coordinator.start()
      await transport.login(expiring)
      transport.foreground()
      await flush()
      const transportFailure = transport.coordinator.getSnapshot()
      transport.foreground()
      await flush()
      const commitSession = vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('persisted commit rejected'))
        .mockResolvedValueOnce(undefined)
      const commitRefresh = vi.fn(async () => ({ data: { session: recovered }, error: null }))
      const commit = harness({ commitPersistedSession: commitSession, refreshSession: commitRefresh })
      commit.coordinator.start()
      await commit.login(expiring)
      commit.foreground()
      await flush()
      const commitFailure = commit.coordinator.getSnapshot()
      commit.foreground()
      await flush()
      await flush()
      const staleRefreshGate = deferred<{ data: { session: Session | null }; error: unknown }>()
      const staleRefresh = vi.fn(() => staleRefreshGate.promise)
      const stale = harness({
        refreshSession: staleRefresh,
        getUser: vi.fn(async (accessToken) => {
          const id = accessToken === 'access-user-b' ? 'user-b' : 'user-a'
          return { data: { user: session(id).user }, error: null }
        }),
      })
      stale.coordinator.start()
      await stale.login(expiring)
      stale.foreground()
      await stale.login(session('user-b'))
      staleRefreshGate.reject(new Error('late account A refresh rejection'))
      await flush()
      const stoppedRefreshGate = deferred<{ data: { session: Session | null }; error: unknown }>()
      const stoppedRefresh = vi.fn(() => stoppedRefreshGate.promise)
      const stopped = harness({ refreshSession: stoppedRefresh })
      const stop = stopped.coordinator.start()
      await stopped.login(expiring)
      stopped.foreground()
      const stoppedSnapshot = stopped.coordinator.getSnapshot()
      stop()
      stoppedRefreshGate.reject(new Error('stopped refresh rejection'))
      await flush()
      const sameTokenGate = deferred<{ data: { session: Session | null }; error: unknown }>()
      const sameTokenRefresh = vi.fn(() => sameTokenGate.promise)
      const sameToken = harness({ refreshSession: sameTokenRefresh })
      sameToken.coordinator.start()
      await sameToken.login(expiring)
      sameToken.foreground()
      await sameToken.login(expiring)
      sameTokenGate.reject(new Error('old generation same-token rejection'))
      await flush()
      const restartedGate = deferred<{ data: { session: Session | null }; error: unknown }>()
      const restartedRefresh = vi.fn(() => restartedGate.promise)
      const restarted = harness({ refreshSession: restartedRefresh })
      const stopOldGeneration = restarted.coordinator.start()
      await restarted.login(expiring)
      restarted.foreground()
      stopOldGeneration()
      restarted.coordinator.start()
      await restarted.login(expiring)
      restartedGate.reject(new Error('old stopped generation same-token rejection'))
      await flush()
      expect({
        unhandled,
        transport: {
          failureStatus: transportFailure.status,
          failureError: transportFailure.error?.message,
          refreshCalls: transportRefresh.mock.calls.length,
          finalStatus: transport.coordinator.getSnapshot().status,
        },
        commit: {
          failureStatus: commitFailure.status,
          failureError: commitFailure.error?.message,
          refreshCalls: commitRefresh.mock.calls.length,
          finalStatus: commit.coordinator.getSnapshot().status,
        },
        stale: {
          refreshCalls: staleRefresh.mock.calls.length,
          status: stale.coordinator.getSnapshot().status,
          userId: stale.coordinator.getSnapshot().user?.id,
        },
        stopped: {
          refreshCalls: stoppedRefresh.mock.calls.length,
          snapshotUnchanged: stopped.coordinator.getSnapshot() === stoppedSnapshot,
        },
        sameToken: {
          refreshCalls: sameTokenRefresh.mock.calls.length,
          status: sameToken.coordinator.getSnapshot().status,
          error: sameToken.coordinator.getSnapshot().error?.message,
        },
        restarted: {
          refreshCalls: restartedRefresh.mock.calls.length,
          status: restarted.coordinator.getSnapshot().status,
          error: restarted.coordinator.getSnapshot().error?.message,
        },
      }).toEqual({
        unhandled: [],
        transport: {
          failureStatus: 'degraded',
          failureError: 'refresh transport rejected',
          refreshCalls: 2,
          finalStatus: 'authenticated',
        },
        commit: {
          failureStatus: 'degraded',
          failureError: 'persisted commit rejected',
          refreshCalls: 2,
          finalStatus: 'authenticated',
        },
        stale: { refreshCalls: 1, status: 'authenticated', userId: 'user-b' },
        stopped: { refreshCalls: 1, snapshotUnchanged: true },
        sameToken: { refreshCalls: 1, status: 'authenticated', error: undefined },
        restarted: { refreshCalls: 1, status: 'authenticated', error: undefined },
      })
    } finally {
      processEvents.off('unhandledRejection', onUnhandled)
    }
  })
  it('makes foreground inert without a session and during logout or terminal storage work', async () => {
    const signOut = deferred<{ error: unknown }>()
    const getUser = vi.fn(async () => ({ data: { user: session().user }, error: null as unknown }))
    const failedLogout = harness({ getUser, signOut: vi.fn(() => signOut.promise) })
    failedLogout.coordinator.start()
    failedLogout.foreground()
    expect(getUser).not.toHaveBeenCalled()
    await failedLogout.login(session())
    getUser.mockClear()
    const logout = failedLogout.coordinator.logout()
    failedLogout.foreground()
    expect(getUser).not.toHaveBeenCalled()
    signOut.resolve({ error: new Error('offline') })
    await expect(logout).rejects.toThrow('offline')
    failedLogout.foreground()
    expect(getUser).toHaveBeenCalledOnce()
    const clearPersistedSession = vi.fn(async () => { throw new Error('storage offline') })
    const terminal = harness({ clearPersistedSession })
    terminal.coordinator.start()
    await terminal.login(session())
    vi.mocked(terminal.deps.getUser).mockClear()
    await expect(terminal.coordinator.logout()).rejects.toThrow('storage offline')
    terminal.foreground()
    expect(terminal.deps.getUser).not.toHaveBeenCalled()
  })
  it('separates explicit auth expiry from a retryable transport failure', async () => {
    const h = harness({
      getUser: vi.fn(async () => ({ data: { user: null }, error: new AuthSessionMissingError() })),
    })
    h.coordinator.start()
    h.fire('INITIAL_SESSION', session())
    await flush()
    expect(h.coordinator.getSnapshot()).toMatchObject({ status: 'expired', session: null, user: null })
    expect(h.deps.clearMirror).toHaveBeenCalledOnce()
    expect(h.deps.clearMirror).toHaveBeenCalledWith('lost')
    expect(h.deps.publishSession).toHaveBeenLastCalledWith('USER_EXPIRED', null)
  })
  it('explicit-expiry-clears-persisted-session-once', async () => {
    const clearPersistedSession = vi.fn()
    const h = harness({
      getUser: vi.fn(async () => ({
        data: { user: null },
        error: { name: 'AuthApiError', status: 403, code: 'user_not_found' },
      })),
      clearPersistedSession,
    })
    h.coordinator.start()
    h.fire('INITIAL_SESSION', session())
    await flush()
    expect(h.coordinator.getSnapshot()).toMatchObject({ status: 'expired', session: null })
    expect(clearPersistedSession).toHaveBeenCalledOnce()
    expect(h.deps.clearMirror).toHaveBeenCalledOnce()
  })
  it('keeps terminal cleanup degraded and retries when persisted-session removal fails', async () => {
    vi.useFakeTimers()
    const clearPersistedSession = vi.fn()
      .mockRejectedValueOnce(new Error('storage unavailable'))
      .mockResolvedValueOnce(undefined)
    const h = harness({
      getUser: vi.fn(async () => ({
        data: { user: null }, error: { name: 'AuthApiError', code: 'user_not_found' },
      })),
      clearPersistedSession,
    })
    h.coordinator.start()
    h.fire('INITIAL_SESSION', session())
    await vi.advanceTimersByTimeAsync(0)
    expect(h.coordinator.getSnapshot()).toMatchObject({ status: 'degraded', session: { user: { id: 'user-a' } } })
    expect(h.deps.publishSession).not.toHaveBeenCalledWith('USER_EXPIRED', null)
    expect(h.deps.clearMirror).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(clearPersistedSession).toHaveBeenCalledTimes(2)
    expect(h.deps.clearMirror).toHaveBeenCalledOnce()
    expect(h.coordinator.getSnapshot()).toMatchObject({ status: 'expired', session: null })
  })
  it('identity-profile-gap-never-expires-auth-session', async () => {
    vi.useFakeTimers()
    const hydrateUser = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(profile())
    const h = harness({ hydrateUser })
    h.coordinator.start()
    h.fire('INITIAL_SESSION', session())
    await vi.advanceTimersByTimeAsync(0)
    expect(h.coordinator.getSnapshot()).toMatchObject({
      status: 'degraded',
      session: { access_token: 'access-user-a' },
      user: { id: 'user-a' },
    })
    expect(h.deps.clearMirror).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(h.coordinator.getSnapshot()).toMatchObject({ status: 'authenticated', user: profile() })
  })
  it('keeps an unreadable identity profile degraded without clearing the mirror', async () => {
    const h = harness({ hydrateUser: vi.fn(async () => { throw new Error('identity proxy parse failure') }) })
    h.coordinator.start()
    h.fire('INITIAL_SESSION', session())
    await flush()
    expect(h.coordinator.getSnapshot()).toMatchObject({ status: 'degraded', user: { id: 'user-a' } })
    expect(h.deps.clearMirror).not.toHaveBeenCalled()
  })
  it('treats only explicit refresh/session codes as permanent, not every HTTP 400', async () => {
    const unknown400 = harness({
      refreshSession: vi.fn(async () => ({
        data: { session: null },
        error: { name: 'AuthApiError', status: 400, code: 'bad_json', message: 'proxy response' },
      })),
    })
    unknown400.coordinator.start()
    await unknown400.login(session())
    await unknown400.coordinator.refresh()
    expect(unknown400.coordinator.getSnapshot()).toMatchObject({ status: 'degraded', user: { id: 'user-a' } })
    expect(unknown400.deps.clearMirror).not.toHaveBeenCalled()
    expect(unknown400.deps.clearPersistedSession).not.toHaveBeenCalled()
    const revoked = harness({
      refreshSession: vi.fn(async () => ({
        data: { session: null },
        error: { name: 'AuthApiError', status: 400, code: 'refresh_token_already_used' },
      })),
    })
    revoked.coordinator.start()
    await revoked.login(session())
    await revoked.coordinator.refresh()
    expect(revoked.coordinator.getSnapshot()).toMatchObject({ status: 'expired', user: null })
    expect(revoked.deps.clearMirror).toHaveBeenCalledOnce()
    expect(revoked.deps.clearPersistedSession).toHaveBeenCalledOnce()
  })
  it('uses one refresh flight for concurrent callers and publishes the rotated session once', async () => {
    const refreshGate = deferred<{ data: { session: Session | null }; error: unknown }>()
    const refreshSession = vi.fn(() => refreshGate.promise)
    const h = harness({ refreshSession })
    h.coordinator.start()
    await h.login(session())
    const first = h.coordinator.refresh()
    const second = h.coordinator.refresh()
    expect(first).toBe(second)
    expect(refreshSession).toHaveBeenCalledOnce()
    const rotated = { ...session(), access_token: 'access-rotated' } as Session
    refreshGate.resolve({ data: { session: rotated }, error: null })
    await first
    expect(h.coordinator.getSnapshot().session?.access_token).toBe('access-rotated')
  })
  it('releases a timed-out refresh for retry and retains all auth sinks on timed-out logout', async () => {
    vi.useFakeTimers()
    const timeout = new AuthRetryableFetchError('Auth request timed out', 0)
    const refreshGate = deferred<{ data: { session: Session | null }; error: unknown }>()
    const rotated = { ...session(), access_token: 'access-rotated', refresh_token: 'refresh-rotated' } as Session
    const refreshSession = vi.fn()
      .mockImplementationOnce(() => refreshGate.promise)
      .mockResolvedValueOnce({ data: { session: rotated }, error: null })
    const h = harness({
      refreshSession,
      signOut: vi.fn(async () => ({ error: timeout })),
    })
    h.coordinator.start()
    await h.login(session())
    const first = h.coordinator.refresh()
    const shared = h.coordinator.refresh()
    expect(shared).toBe(first)
    refreshGate.resolve({ data: { session: null }, error: timeout })
    await first
    expect(h.coordinator.getSnapshot()).toMatchObject({ status: 'degraded', session: { user: { id: 'user-a' } } })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(refreshSession).toHaveBeenCalledTimes(2)
    expect(h.coordinator.getSnapshot()).toMatchObject({ status: 'authenticated', session: rotated })
    await expect(h.coordinator.logout()).rejects.toBe(timeout)
    expect(h.coordinator.getSnapshot()).toMatchObject({ status: 'degraded', session: rotated })
    expect(h.deps.clearPersistedSession).not.toHaveBeenCalled()
    expect(h.deps.clearMirror).not.toHaveBeenCalled()
  })
  it('rejects failed logout visibly while keeping the confirmed account and mirror', async () => {
    const h = harness({ signOut: vi.fn(async () => ({ error: new Error('network down') })) })
    h.coordinator.start()
    await h.login(session())
    await expect(h.coordinator.logout()).rejects.toThrow('network down')
    expect(h.coordinator.getSnapshot()).toMatchObject({ status: 'degraded', user: { id: 'user-a' } })
    expect(h.deps.clearMirror).not.toHaveBeenCalled()
    expect(h.deps.clearPersistedSession).not.toHaveBeenCalled()
  })
  it('disposal blocks late listener, restore, getUser, refresh, and retry completions', async () => {
    vi.useFakeTimers()
    const restoreGate = deferred<{ data: { session: Session | null }; error: unknown }>()
    const restore = harness({ getSession: vi.fn(() => restoreGate.promise) })
    const stopRestore = restore.coordinator.start()
    stopRestore()
    restore.fire('INITIAL_SESSION', session())
    restoreGate.resolve({ data: { session: session() }, error: null })
    await vi.advanceTimersByTimeAsync(0)
    expect(restore.deps.publishSession).not.toHaveBeenCalled()
    expect(restore.deps.writeMirror).not.toHaveBeenCalled()
    const userGate = deferred<{ data: { user: User | null }; error: unknown }>()
    const validating = harness({ getUser: vi.fn(() => userGate.promise) })
    const stopValidation = validating.coordinator.start()
    validating.fire('INITIAL_SESSION', session())
    await vi.advanceTimersByTimeAsync(0)
    stopValidation()
    userGate.resolve({ data: { user: session().user }, error: null })
    await vi.advanceTimersByTimeAsync(0)
    expect(validating.coordinator.getSnapshot().user?.nickname).toBe('')
    expect(validating.deps.writeMirror).toHaveBeenCalledOnce()
    const refreshGate = deferred<{ data: { session: Session | null }; error: unknown }>()
    const refreshing = harness({ refreshSession: vi.fn(() => refreshGate.promise) })
    const stopRefresh = refreshing.coordinator.start()
    await refreshing.login(session())
    const refresh = refreshing.coordinator.refresh()
    stopRefresh()
    refreshGate.resolve({ data: { session: { ...session(), access_token: 'late-token' } as Session }, error: null })
    await refresh
    expect(refreshing.coordinator.getSnapshot().session?.access_token).toBe('access-user-a')
    expect(refreshing.deps.writeMirror).toHaveBeenCalledOnce()
    const retryingGetUser = vi.fn(async () => ({
      data: { user: null }, error: new AuthRetryableFetchError('offline', 0),
    }))
    const retrying = harness({ getUser: retryingGetUser })
    const stopRetry = retrying.coordinator.start()
    retrying.fire('INITIAL_SESSION', session())
    await vi.advanceTimersByTimeAsync(0)
    stopRetry()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(retryingGetUser).toHaveBeenCalledOnce()
  })
  it('keeps ambiguous sign-out degraded while session restore retries', async () => {
    vi.useFakeTimers()
    const restoreSession = vi.fn()
      .mockResolvedValueOnce({ data: { session: null }, error: new AuthRetryableFetchError('offline', 0) })
      .mockResolvedValueOnce({ data: { session: session('user-b') }, error: null })
    const h = harness({
      restoreSession,
      getUser: vi.fn(async () => ({ data: { user: session('user-b').user }, error: null })),
    })
    h.coordinator.start()
    await h.login(session('user-b'))
    h.fire('SIGNED_OUT', null)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.coordinator.getSnapshot()).toMatchObject({ status: 'degraded', user: { id: 'user-b' } })
    expect(h.deps.clearPersistedSession).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(restoreSession).toHaveBeenCalledTimes(2)
    expect(h.coordinator.getSnapshot()).toMatchObject({ status: 'authenticated', user: { id: 'user-b' } })
  })
  it('aborts a late account A persisted clear before it can remove account B', async () => {
    const clearGate = deferred<void>()
    const removed: string[] = []
    const clearPersistedSession = vi.fn(async (value: Session, signal: AbortSignal) => {
      await clearGate.promise
      if (!signal.aborted) removed.push(value.user.id)
    })
    const getUser = vi.fn()
      .mockResolvedValueOnce({ data: { user: null }, error: { name: 'AuthApiError', code: 'user_not_found' } })
      .mockResolvedValueOnce({ data: { user: session('user-b').user }, error: null })
    const h = harness({ clearPersistedSession, getUser })
    h.coordinator.start()
    h.fire('INITIAL_SESSION', session('user-a'))
    await flush()
    expect(clearPersistedSession).toHaveBeenCalledOnce()
    await h.login(session('user-b'))
    clearGate.resolve()
    await flush()
    expect(removed).toEqual([])
    expect(h.deps.clearMirror).not.toHaveBeenCalled()
    expect(h.coordinator.getSnapshot()).toMatchObject({ status: 'authenticated', user: { id: 'user-b' } })
  })
  it('a restart after explicit expiry cannot restore the cleared session', async () => {
    let persisted: Session | null = session()
    const first = harness({
      getUser: vi.fn(async () => ({
        data: { user: null }, error: { name: 'AuthApiError', code: 'user_not_found' },
      })),
      clearPersistedSession: vi.fn(async () => { persisted = null }),
    })
    const stop = first.coordinator.start()
    first.fire('INITIAL_SESSION', persisted)
    await flush()
    expect(first.coordinator.getSnapshot().status).toBe('expired')
    stop()
    const restarted = harness({ getSession: vi.fn(async () => ({ data: { session: persisted }, error: null })) })
    restarted.coordinator.start()
    await flush()
    expect(restarted.coordinator.getSnapshot()).toMatchObject({ status: 'anonymous', session: null, user: null })
    expect(restarted.deps.writeMirror).not.toHaveBeenCalled()
  })
  it('ignores late non-interactive session events after expiry but accepts a new sign-in', async () => {
    const getUser = vi.fn()
      .mockResolvedValueOnce({ data: { user: null }, error: { name: 'AuthApiError', code: 'user_not_found' } })
      .mockResolvedValue({ data: { user: session('user-b').user }, error: null })
    const h = harness({ getUser })
    h.coordinator.start()
    h.fire('INITIAL_SESSION', session('user-a'))
    await flush()
    expect(h.coordinator.getSnapshot().status).toBe('expired')
    const mirrorCallsAfterExpiry = vi.mocked(h.deps.writeMirror).mock.calls.length
    h.fire('TOKEN_REFRESHED', session('user-a'))
    h.fire('INITIAL_SESSION', session('user-a'))
    await flush()
    expect(h.coordinator.getSnapshot()).toMatchObject({ status: 'expired', session: null, user: null })
    expect(h.deps.writeMirror).toHaveBeenCalledTimes(mirrorCallsAfterExpiry)
    h.fire('SIGNED_IN', session('user-b'))
    await flush()
    expect(h.coordinator.getSnapshot()).toMatchObject({ status: 'expired', session: null })
    await h.login(session('user-b'))
    expect(h.coordinator.getSnapshot()).toMatchObject({ status: 'authenticated', user: { id: 'user-b' } })
    expect(h.deps.writeMirror).toHaveBeenCalledTimes(mirrorCallsAfterExpiry + 1)
  })
  // @@@4395 —— 醒来不该被迫重登:恢复路径上的两个洞。两条用例都必须能在旧实现上判假。
  it('recovers with the persisted rotated refresh token instead of resubmitting the failed one', async () => {
    const rotated = { ...session(), refresh_token: 'refresh-user-a-rotated' } as Session
    const h = harness({ getPersistedSessionState: vi.fn(() => ({ bootCandidate: rotated, warning: null })) })
    h.coordinator.start()
    await h.login(session())
    await flush()
    h.fire('SIGNED_OUT', null)
    await flush()
    expect(h.deps.restoreSession).toHaveBeenCalledWith(
      expect.objectContaining({ refresh_token: 'refresh-user-a-rotated' }),
    )
  })
})
