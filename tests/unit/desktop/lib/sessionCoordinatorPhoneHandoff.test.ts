// @vitest-environment jsdom
import type { Session, User } from '@supabase/supabase-js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionCoordinator, type SessionCoordinatorDeps } from '../../../../apps/desktop/src/lib/sessionCoordinator'
import { phoneHostRefreshSession, phoneHostSessionForHandoff, setPhoneHostAuthHandoffBarrier, withPhoneHostAuthHandoff } from '../../../../apps/desktop/src/lib/phoneHostAuth'
import { getRendererSession, publishRendererSession } from '../../../../apps/desktop/src/lib/sessionPublication'

const native = vi.hoisted(() => ({ authSession: vi.fn() }))
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true, isPluginAvailable: () => true }, registerPlugin: () => native }))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ supabase: { auth: {} }, mainAuthSessionStorage: {} }))
vi.mock('../../../../apps/desktop/src/lib/auth', () => ({ hydrateIdentityAuthUser: vi.fn() }))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: { capabilities: { localHumanAuthSession: false } } }))

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
function session(suffix: string): Session {
  return { access_token: `access-${suffix}`, refresh_token: `refresh-${suffix}`, expires_in: 3600, token_type: 'bearer', user: { id: 'owner', aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' } } as Session
}
function harness(overrides: Partial<SessionCoordinatorDeps> = {}) {
  const old = session('old')
  const deps: SessionCoordinatorDeps = {
    getSession: async () => ({ data: { session: old }, error: null }),
    getUser: async () => ({ data: { user: old.user }, error: null }),
    refreshSession: async () => ({ data: { session: session('new') }, error: null }),
    restoreSession: async () => ({ data: { session: old }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    signOut: async () => ({ error: null }),
    hydrateUser: async (user: User) => ({ id: user.id, email: '', nickname: 'Owner' }),
    publishSession: () => {}, writeMirror: async () => {}, clearMirror: async () => {},
    getPersistedSessionState: () => ({ bootCandidate: null, warning: null }),
    commitPersistedSession: async () => {}, clearPersistedSession: async () => {},
    subscribeAppForeground: () => () => {},
    ...overrides,
  }
  const coordinator = new SessionCoordinator(deps)
  setPhoneHostAuthHandoffBarrier(coordinator.captureAuthHandoff)
  return coordinator
}

afterEach(() => {
  setPhoneHostAuthHandoffBarrier(() => Promise.resolve())
  native.authSession.mockReset()
  publishRendererSession('TEST_END', null)
})

describe('phone host handoff across the real coordinator commit/publication boundary', () => {
  it('waits after SDK refresh returns until the rotated session is persisted and published', async () => {
    const commit = deferred()
    const events: string[] = []
    let published: Session | null = null
    const sdkRefresh = vi.fn(async () => { events.push('sdk-return'); return { data: { session: session('new') }, error: null } })
    native.authSession.mockResolvedValue({ available: false, session: null })
    const coordinator = harness({
      refreshSession: (value) => phoneHostRefreshSession(value.refresh_token, sdkRefresh),
      commitPersistedSession: async (value) => { if (value.refresh_token === 'refresh-new') { events.push('persist-begin'); await commit.promise; events.push('persist-end') } },
      publishSession: (_event, value) => { published = value; if (value?.refresh_token === 'refresh-new') events.push('publish-new') },
    })
    const stop = coordinator.start()
    try {
      await vi.waitFor(() => expect(coordinator.getSnapshot().status).toBe('authenticated'))
      const refreshing = coordinator.refresh()
      await vi.waitFor(() => expect(events).toEqual(['sdk-return', 'persist-begin']))
      const configure = vi.fn(async () => {
        events.push('configure')
        return { published: published?.refresh_token, snapshot: coordinator.getSnapshot().session?.refresh_token }
      })
      const handingOff = withPhoneHostAuthHandoff(configure)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(configure).not.toHaveBeenCalled()
      commit.resolve()
      await expect(handingOff).resolves.toEqual({ published: 'refresh-new', snapshot: 'refresh-new' })
      await refreshing
      expect(events).toEqual(['sdk-return', 'persist-begin', 'persist-end', 'publish-new', 'configure'])
    } finally { commit.resolve(); stop() }
  })

  it('does not capture an auth request admitted behind configure and delegates that refresh to the new host', async () => {
    const configured = deferred()
    let hostOwnsRefresh = false
    native.authSession.mockImplementation(async () => ({ available: hostOwnsRefresh, session: hostOwnsRefresh ? session('native') : null }))
    const fallback = vi.fn(async () => ({ data: { session: session('unexpected-sdk') }, error: null }))
    const coordinator = harness({ refreshSession: (value) => phoneHostRefreshSession(value.refresh_token, fallback) })
    const stop = coordinator.start()
    try {
      await vi.waitFor(() => expect(coordinator.getSnapshot().status).toBe('authenticated'))
      const configuring = vi.fn(async () => { await configured.promise; hostOwnsRefresh = true })
      const handingOff = withPhoneHostAuthHandoff(configuring)
      // This marker is later than configure's admission, even before its callback gets a microtask.
      const refreshing = coordinator.refresh()
      await vi.waitFor(() => expect(configuring).toHaveBeenCalledOnce())
      expect(native.authSession).not.toHaveBeenCalled()
      configured.resolve()
      await Promise.all([handingOff, refreshing])
      expect(fallback).not.toHaveBeenCalled()
      expect(coordinator.getSnapshot().session?.refresh_token).toBe('refresh-native')
      await expect(coordinator.captureAuthHandoff()).resolves.toEqual([])
    } finally { configured.resolve(); stop() }
  })

  it('hands off a late SDK rotation after the coordinator budget, only for its exact source session', async () => {
    vi.useFakeTimers()
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    let finishSdk!: (result: { data: { session: Session }; error: null }) => void
    const sdk = new Promise<{ data: { session: Session }; error: null }>((resolve) => { finishSdk = resolve })
    native.authSession.mockResolvedValue({ available: false, session: null })
    const coordinator = harness({ refreshSession: (value) => phoneHostRefreshSession(value.refresh_token, () => sdk) })
    const stop = coordinator.start()
    try {
      await vi.advanceTimersByTimeAsync(0)
      publishRendererSession('TEST_BOOT', coordinator.getSnapshot().session)
      const refreshing = coordinator.refresh()
      const configure = vi.fn(async () => phoneHostSessionForHandoff(getRendererSession()!).refresh_token)
      const handingOff = withPhoneHostAuthHandoff(configure)
      await vi.advanceTimersByTimeAsync(15_001)
      await refreshing
      expect(coordinator.getSnapshot().status).toBe('degraded')
      expect(configure).not.toHaveBeenCalled()
      finishSdk({ data: { session: session('late-rotation') }, error: null })
      await vi.advanceTimersByTimeAsync(0)
      await expect(handingOff).resolves.toBe('refresh-late-rotation')
      expect(getRendererSession()?.refresh_token).toBe('refresh-old')
      const anotherOwner = { ...session('elsewhere'), user: { ...session('elsewhere').user, id: 'other-owner' } }
      expect(phoneHostSessionForHandoff(anotherOwner)).toBe(anotherOwner)
      const reauthenticated = session('new-login')
      expect(phoneHostSessionForHandoff(reauthenticated)).toBe(reauthenticated)
    } finally {
      finishSdk({ data: { session: session('late-rotation') }, error: null })
      stop(); quiet.mockRestore(); vi.useRealTimers()
    }
  })
})
