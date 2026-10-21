// @vitest-environment jsdom
// #7408 同一个人续期 ❌ 重建登录边界:重建会把在途请求就地中止,各处把中止当成生命周期取消安静丢掉、没人重读
// (开机一秒后的一次续期打断了通讯录那一读,咕咕整页一直「正在读你的咕咕是谁」)。换了人、登出后重登才换新边界。
import type { Session } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { currentAuthSessionSignal } from '../../../../apps/desktop/src/lib/authSessionLoss'
import { SessionCoordinator, type SessionCoordinatorDeps } from '../../../../apps/desktop/src/lib/sessionCoordinator'

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
function session(id = 'user-a', version = 1): Session {
  return {
    access_token: `access-${id}-${version}`,
    refresh_token: `refresh-${id}-${version}`,
    token_type: 'bearer',
    expires_in: 3600,
    user: { id, aud: 'authenticated', role: 'authenticated', email: `${id}@example.test`, user_metadata: {}, app_metadata: {}, created_at: '2026-01-01T00:00:00.000Z' },
  } as Session
}
function harness(refreshed: Session) {
  const deps: SessionCoordinatorDeps = {
    getSession: vi.fn(() => new Promise<{ data: { session: Session | null }; error: unknown }>(() => {})),
    getUser: vi.fn(async () => ({ data: { user: refreshed.user }, error: null })),
    refreshSession: vi.fn(async () => ({ data: { session: refreshed }, error: null })),
    restoreSession: vi.fn(async () => ({ data: { session: refreshed }, error: null })),
    onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    signOut: vi.fn(async () => ({ error: null })),
    hydrateUser: vi.fn(async (user) => ({ id: user.id, email: user.email ?? '', nickname: user.id, bio: null })),
    publishSession: vi.fn(),
    writeMirror: vi.fn(async () => {}),
    clearMirror: vi.fn(async () => {}),
    getPersistedSessionState: vi.fn(() => ({ bootCandidate: null, warning: null })),
    commitPersistedSession: vi.fn(async () => {}),
    clearPersistedSession: vi.fn(async () => {}),
    subscribeAppForeground: vi.fn(() => () => {}),
  }
  const coordinator = new SessionCoordinator(deps)
  coordinator.start()
  return { coordinator, login: (value: Session) => coordinator.acceptInteractiveSession(coordinator.beginInteractiveLogin(), value) }
}

describe('登录边界与续期', () => {
  it('同一个人续期:边界不变、在途请求 ❌ 被中止', async () => {
    const h = harness(session('user-a', 2))
    await h.login(session('user-a', 1))
    const inFlight = currentAuthSessionSignal()
    await h.coordinator.refresh()
    await flush()
    expect(h.coordinator.getSnapshot().session?.access_token).toBe('access-user-a-2')
    expect(inFlight.aborted).toBe(false)
    expect(currentAuthSessionSignal()).toBe(inFlight)
  })

  it('换了人:旧边界中止,换新边界', async () => {
    const h = harness(session('user-b', 1))
    await h.login(session('user-a', 1))
    const before = currentAuthSessionSignal()
    await h.login(session('user-b', 1))
    expect(before.aborted).toBe(true)
    expect(currentAuthSessionSignal().aborted).toBe(false)
  })

  it('登出后同一个人重登:登出时中止的边界换成新的(❌ 新会话的请求一出门就被取消)', async () => {
    const h = harness(session('user-a', 1))
    await h.login(session('user-a', 1))
    const before = currentAuthSessionSignal()
    await h.coordinator.logout()
    expect(before.aborted).toBe(true)
    await h.login(session('user-a', 2))
    expect(currentAuthSessionSignal().aborted).toBe(false)
  })
})
