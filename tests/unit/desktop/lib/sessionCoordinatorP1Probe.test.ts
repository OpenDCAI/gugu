// @vitest-environment jsdom
import type { Session, User } from '@supabase/supabase-js'
import type { EventEmitter } from 'node:events'
import process from 'node:process'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SessionCoordinator,
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
      user_metadata: {},
      app_metadata: {},
      created_at: '2026-01-01T00:00:00.000Z',
    },
  } as Session
}

function profile(id = 'user-a'): AuthUser {
  return { id, email: `${id}@example.test`, nickname: `Canonical ${id}`, bio: null }
}

function rejectedGate<T>() {
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((_resolve, rejectPromise) => { reject = rejectPromise })
  return { promise, reject }
}

function harness(overrides: Partial<SessionCoordinatorDeps> = {}) {
  let authListener: (event: string, value: Session | null) => void = () => {}
  let foregroundListener = () => {}
  const deps: SessionCoordinatorDeps = {
    getSession: vi.fn(() => new Promise<{ data: { session: Session | null }; error: unknown }>(() => {})),
    getUser: vi.fn(async (accessToken) => ({
      data: { user: session(accessToken.replace(/^access-/, '')).user }, error: null,
    })),
    refreshSession: vi.fn(async () => ({ data: { session: session() }, error: null })),
    restoreSession: vi.fn(async () => ({ data: { session: session() }, error: null })),
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
    subscribeAppForeground: vi.fn((listener) => {
      foregroundListener = listener
      return vi.fn()
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
  }
}

describe('SessionCoordinator P1 probes', () => {
  beforeEach(() => vi.useRealTimers())

  it('owns a rejected signOut and restores logout lifecycle ownership', async () => {
    const getUser = vi.fn(async () => ({ data: { user: session().user }, error: null }))
    const restoreSession = vi.fn(async () => ({ data: { session: session() }, error: null }))
    const h = harness({
      getUser,
      restoreSession,
      signOut: vi.fn(async () => { throw new Error('raw signOut rejection') }),
    })
    h.coordinator.start()
    await h.login(session())
    getUser.mockClear()

    await expect(h.coordinator.logout()).rejects.toThrow('raw signOut rejection')
    const immediate = h.coordinator.getSnapshot()
    h.foreground()
    h.fire('SIGNED_OUT', null)
    await flush()

    expect({
      immediateStatus: immediate.status,
      immediateError: immediate.error?.message,
      foregroundValidationCalls: getUser.mock.calls.length,
      signedOutRecoveryCalls: restoreSession.mock.calls.length,
    }).toEqual({
      immediateStatus: 'degraded',
      immediateError: 'raw signOut rejection',
      foregroundValidationCalls: 1,
      signedOutRecoveryCalls: 1,
    })
  })

  it('owns and retries a raw recovery rejection from the auth listener', async () => {
    vi.useFakeTimers()
    const unhandled: string[] = []
    const processEvents = process as unknown as EventEmitter
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason instanceof Error ? reason.message : String(reason))
    }
    processEvents.on('unhandledRejection', onUnhandled)
    const restoreSession = vi.fn()
      .mockRejectedValueOnce(new Error('raw recovery rejection'))
      .mockResolvedValueOnce({ data: { session: session() }, error: null })
    const h = harness({ restoreSession })
    try {
      h.coordinator.start()
      await h.login(session())

      h.fire('SIGNED_OUT', null)
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(1_000)

      expect({
        calls: restoreSession.mock.calls.length,
        status: h.coordinator.getSnapshot().status,
        error: h.coordinator.getSnapshot().error?.message,
        unhandled,
      }).toEqual({
        calls: 2,
        status: 'authenticated',
        error: undefined,
        unhandled: [],
      })
    } finally {
      processEvents.off('unhandledRejection', onUnhandled)
    }
  })

  it('owns persistence rejection from a session-bearing auth event', async () => {
    const unhandled: string[] = []
    const processEvents = process as unknown as EventEmitter
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason instanceof Error ? reason.message : String(reason))
    }
    processEvents.on('unhandledRejection', onUnhandled)
    const commitPersistedSession = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('event persistence rejection'))
    const h = harness({ commitPersistedSession })
    try {
      h.coordinator.start()
      await h.login(session())
      h.fire('TOKEN_REFRESHED', session())
      await flush()
      await flush()

      expect({
        status: h.coordinator.getSnapshot().status,
        error: h.coordinator.getSnapshot().error?.message,
        unhandled,
      }).toEqual({
        status: 'degraded',
        error: 'event persistence rejection',
        unhandled: [],
      })
    } finally {
      processEvents.off('unhandledRejection', onUnhandled)
    }
  })

  it('keeps stale-generation and stopped recovery rejections inert', async () => {
    vi.useFakeTimers()
    const unhandled: string[] = []
    const processEvents = process as unknown as EventEmitter
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason instanceof Error ? reason.message : String(reason))
    }
    processEvents.on('unhandledRejection', onUnhandled)
    try {
      const staleGate = rejectedGate<{ data: { session: Session | null }; error: unknown }>()
      const staleRestore = vi.fn(() => staleGate.promise)
      const stale = harness({ restoreSession: staleRestore })
      stale.coordinator.start()
      await stale.login(session('user-a'))
      stale.fire('SIGNED_OUT', null)
      await stale.login(session('user-b'))
      staleGate.reject(new Error('late account A recovery rejection'))
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(1_000)

      const stoppedGate = rejectedGate<{ data: { session: Session | null }; error: unknown }>()
      const stoppedRestore = vi.fn(() => stoppedGate.promise)
      const stopped = harness({ restoreSession: stoppedRestore })
      const stop = stopped.coordinator.start()
      await stopped.login(session('user-a'))
      stopped.fire('SIGNED_OUT', null)
      const stoppedSnapshot = stopped.coordinator.getSnapshot()
      stop()
      stoppedGate.reject(new Error('stopped recovery rejection'))
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(1_000)

      expect({
        staleCalls: staleRestore.mock.calls.length,
        staleStatus: stale.coordinator.getSnapshot().status,
        staleUser: stale.coordinator.getSnapshot().user?.id,
        stoppedCalls: stoppedRestore.mock.calls.length,
        stoppedUnchanged: stopped.coordinator.getSnapshot() === stoppedSnapshot,
        unhandled,
      }).toEqual({
        staleCalls: 1,
        staleStatus: 'authenticated',
        staleUser: 'user-b',
        stoppedCalls: 1,
        stoppedUnchanged: true,
        unhandled: [],
      })
    } finally {
      processEvents.off('unhandledRejection', onUnhandled)
    }
  })
})
