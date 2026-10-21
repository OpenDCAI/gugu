// @vitest-environment jsdom
import type { Session, User } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import {
  SessionCoordinator,
  type SessionCoordinatorDeps,
} from '../../../../apps/desktop/src/lib/sessionCoordinator'
import type { AuthUser } from '../../../../apps/desktop/src/store/auth'
function session(id: string): Session {
  return {
    access_token: `access-${id}-1`,
    refresh_token: `refresh-${id}-1`,
    token_type: 'bearer',
    expires_in: 3600,
    user: {
      id,
      aud: 'authenticated',
      role: 'authenticated',
      email: `${id}@example.test`,
      user_metadata: { nickname: id },
      app_metadata: {},
      created_at: '2026-01-01T00:00:00.000Z',
    },
  } as Session
}
function harness(overrides: Partial<SessionCoordinatorDeps> = {}) {
  let authListener: (event: string, value: Session | null) => void = () => {}
  const deps: SessionCoordinatorDeps = {
    // 默认永不 resolve = 卡在 boot-restoring,正是 #5025 那个窗口。
    getSession: vi.fn(() => new Promise<{ data: { session: Session | null }; error: unknown }>(() => {})),
    getUser: vi.fn(async () => ({ data: { user: session('user-a').user }, error: null })),
    refreshSession: vi.fn(async () => ({ data: { session: session('user-a') }, error: null })),
    restoreSession: vi.fn(async () => ({ data: { session: session('user-a') }, error: null })),
    onAuthStateChange: vi.fn((listener) => {
      authListener = listener
      return { data: { subscription: { unsubscribe: vi.fn() } } }
    }),
    signOut: vi.fn(async () => ({ error: null })),
    hydrateUser: vi.fn(async (user: User) => ({ id: user.id, email: '', nickname: user.id } as AuthUser)),
    publishSession: vi.fn(),
    writeMirror: vi.fn(async () => {}),
    clearMirror: vi.fn(async () => {}),
    getPersistedSessionState: vi.fn(() => ({ bootCandidate: null, warning: null })),
    commitPersistedSession: vi.fn(async () => {}),
    clearPersistedSession: vi.fn(async () => {}),
    subscribeAppForeground: () => () => {},
    ...overrides,
  }
  const coordinator = new SessionCoordinator(deps)
  return { coordinator, fire: (event: string, value: Session | null) => authListener(event, value) }
}
describe('#5025 waitForDecidedOwner 区分「还没恢复完」与「没登录」', () => {
  it('有持久化候选时立刻作答,不等恢复落地(路由等着它,窗口越短越好)', async () => {
    const persisted = session('user-a')
    const h = harness({ getPersistedSessionState: vi.fn(() => ({ bootCandidate: persisted, warning: null })) })
    h.coordinator.start()
    expect(h.coordinator.getSnapshot().status).toBe('boot-restoring')
    await expect(h.coordinator.waitForDecidedOwner(5_000)).resolves.toEqual({ decided: true, userId: 'user-a' })
  })
  it('没有持久化候选时不给结论,落地后给出账号', async () => {
    const h = harness()
    h.coordinator.start()
    expect(h.coordinator.getSnapshot().status).toBe('boot-restoring')
    const pending = h.coordinator.waitForDecidedOwner(5_000)
    h.fire('INITIAL_SESSION', session('user-a'))
    await expect(pending).resolves.toEqual({ decided: true, userId: 'user-a' })
  })
  it('预算用完仍未恢复完 → 如实回 decided:false,❌ 不冒充「没登录」', async () => {
    const h = harness()
    h.coordinator.start()
    await expect(h.coordinator.waitForDecidedOwner(20)).resolves.toEqual({ decided: false, userId: null })
  })
  it('确实没人登录(恢复已落地为 anonymous) → decided:true 且 userId 为 null', async () => {
    const h = harness({ getSession: vi.fn(async () => ({ data: { session: null }, error: null })) })
    h.coordinator.start()
    await vi.waitFor(() => expect(h.coordinator.getSnapshot().status).toBe('anonymous'))
    await expect(h.coordinator.waitForDecidedOwner(5_000)).resolves.toEqual({ decided: true, userId: null })
  })
})
