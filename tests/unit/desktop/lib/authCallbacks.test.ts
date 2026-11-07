// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  subscribe: vi.fn(), ready: vi.fn(async () => {}), redirectTo: vi.fn(async () => 'gugu-beta://auth/callback'),
}))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: { authCallbacks: m } }))
beforeEach(() => { vi.resetModules(); m.subscribe.mockReset(); m.ready.mockClear(); m.redirectTo.mockClear() })

it('subscribes before a login consumer exists and retains callbacks through its mount boundary', async () => {
  let incoming!: (url: string) => void
  const upstreamStop = vi.fn()
  m.subscribe.mockImplementation((listener) => { incoming = listener; listener('gugu-beta://auth/callback?code=cold'); return upstreamStop })
  const { authCallbacks, startAuthCallbackRouting } = await import('../../../../apps/desktop/src/lib/authCallbacks')
  const stopRoot = startAuthCallbackRouting()
  const take = vi.fn(), onError = vi.fn()
  const stopLogin = authCallbacks.subscribe(take, onError)
  expect(take).toHaveBeenCalledExactlyOnceWith('gugu-beta://auth/callback?code=cold')
  stopLogin()
  incoming('gugu-beta://auth/callback?code=between-views')
  const next = vi.fn()
  authCallbacks.subscribe(next, onError)()
  expect(next).toHaveBeenCalledExactlyOnceWith('gugu-beta://auth/callback?code=between-views')
  await expect(authCallbacks.redirectTo()).resolves.toBe('gugu-beta://auth/callback')
  await expect(authCallbacks.ready()).resolves.toBeUndefined()
  expect(m.ready).toHaveBeenCalledOnce()
  expect(onError).not.toHaveBeenCalled()
  stopRoot()
  expect(upstreamStop).toHaveBeenCalledOnce()
})

it('retains a failed upstream subscription until auth can show the failure', async () => {
  const failure = new Error('OS callback subscription failed')
  m.subscribe.mockImplementation((_listener, onError) => { onError(failure); return () => {} })
  const { authCallbacks, startAuthCallbackRouting } = await import('../../../../apps/desktop/src/lib/authCallbacks')
  startAuthCallbackRouting()
  const onError = vi.fn()
  authCallbacks.subscribe(vi.fn(), onError)()
  expect(onError).toHaveBeenCalledExactlyOnceWith(failure)
  // Explicit readiness can be retried; success retires the previous source failure.
  await authCallbacks.ready()
  const nextError = vi.fn()
  authCallbacks.subscribe(vi.fn(), nextError)()
  expect(nextError).not.toHaveBeenCalled()
})

it('discards queued and late callbacks after sign-in even when there is no consumer, before another sign-in view mounts', async () => {
  let incoming!: (url: string) => void
  m.subscribe.mockImplementation((listener) => { incoming = listener; return () => {} })
  const { authCallbacks, startAuthCallbackRouting } = await import('../../../../apps/desktop/src/lib/authCallbacks')
  startAuthCallbackRouting()
  incoming('gugu-beta://auth/callback?code=queued-before-session-restored')
  authCallbacks.setAuthenticated(true)
  incoming('gugu-beta://auth/callback?code=late-after-login')
  authCallbacks.setAuthenticated(false)
  const next = vi.fn()
  authCallbacks.subscribe(next, vi.fn())()
  expect(next).not.toHaveBeenCalled()
  const current = vi.fn()
  authCallbacks.subscribe(current, vi.fn())
  incoming('gugu-beta://auth/callback?code=current')
  expect(current).toHaveBeenCalledExactlyOnceWith('gugu-beta://auth/callback?code=current')
})

it('routes an authenticated account callback only to explicit account consumers', async () => {
  let incoming!: (url: string) => void
  m.subscribe.mockImplementation(listener => { incoming = listener; return () => {} })
  const { authCallbacks, startAuthCallbackRouting } = await import('../../../../apps/desktop/src/lib/authCallbacks')
  startAuthCallbackRouting()
  const login = vi.fn(), account = vi.fn()
  authCallbacks.subscribe(login, vi.fn())
  authCallbacks.setAuthenticated(true)
  const stop = authCallbacks.subscribeAccount(account, vi.fn())
  incoming('gugu-beta://auth/callback?code=linking')
  expect(account).toHaveBeenCalledOnce()
  expect(login).not.toHaveBeenCalled()
  stop()
  incoming('gugu-beta://auth/callback?code=late')
  expect(account).toHaveBeenCalledOnce()
  authCallbacks.setAuthenticated(false)
  incoming('gugu-beta://auth/callback?code=login')
  expect(login).toHaveBeenCalledExactlyOnceWith('gugu-beta://auth/callback?code=login')
})
