// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { sessionCoordinator } from '../../../../apps/desktop/src/lib/sessionCoordinator'

const host = vi.hoisted(() => {
  const session = { access_token: 'access-a', refresh_token: 'refresh-a', user: { id: 'user-a', email: 'a@example.test' } }
  return {
    getSession: vi.fn(async () => ({ data: { session }, error: null })),
    getUser: vi.fn(async () => ({ data: { user: session.user }, error: null })),
    onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: () => {} } } })),
    signOut: vi.fn(async () => ({ error: null })),
  }
})
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({
  supabase: { auth: host },
  mainAuthSessionStorage: {
    getState: () => ({ bootCandidate: null, warning: null }),
    commit: async () => {},
    remove: async () => {},
  },
}))
vi.mock('../../../../apps/desktop/src/lib/auth', () => ({
  hydrateIdentityAuthUser: async (user: { id: string }) => ({ id: user.id, email: '', nickname: 'A' }),
}))
vi.mock('../../../../apps/desktop/src/lib/sessionPublication', () => ({ publishRendererSession: () => {} }))
vi.mock('../../../../apps/desktop/src/platform', () => ({
  platform: {
    capabilities: { localHumanAuthSession: false },
    subscribeAppForeground: () => () => {},
  },
}))

it('#6659 sign-out revokes only this device session', async () => {
  const stop = sessionCoordinator.start()
  await vi.waitFor(() => expect(sessionCoordinator.getSnapshot().status).toBe('authenticated'))
  await expect(sessionCoordinator.logout()).resolves.toEqual({ success: true })
  expect(host.signOut).toHaveBeenCalledTimes(1)
  expect(host.signOut).toHaveBeenCalledWith({ scope: 'local' })
  stop()
})
