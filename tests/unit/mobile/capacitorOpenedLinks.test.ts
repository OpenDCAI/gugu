// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({ addListener: vi.fn(), getLaunchUrl: vi.fn(), remove: vi.fn(async () => {}) }))
vi.mock('@capacitor/app', () => ({ App: m }))
beforeEach(() => { vi.resetModules(); m.addListener.mockReset(); m.getLaunchUrl.mockReset(); m.remove.mockClear() })

it('shares one native stream before login and retains both cold auth and later navigation links', async () => {
  const cold = 'gugu-beta://auth/callback?code=cold'
  let send!: (event: { url: string }) => void
  m.addListener.mockImplementation(async (_event, listener) => {
    send = listener
    // BridgeActivity.load calls onNewIntent(getIntent()); AppPlugin retains this appUrlOpen.
    listener({ url: cold })
    return { remove: m.remove }
  })
  const { capacitorPlatform } = await import('../../../apps/desktop/src/platform/capacitor')
  const auth = vi.fn(), navigation = vi.fn(), onError = vi.fn()
  const stopAuth = capacitorPlatform.authCallbacks!.subscribe(auth, onError)
  await capacitorPlatform.authCallbacks!.ready()
  expect(auth).toHaveBeenCalledExactlyOnceWith(cold)
  send({ url: 'gugu-beta://ext/notes/main/cold' })
  const stopNavigation = capacitorPlatform.subscribeOpenedLinks!(navigation, onError)
  expect(navigation).toHaveBeenCalledExactlyOnceWith('gugu-beta://ext/notes/main/cold')
  expect(m.addListener).toHaveBeenCalledExactlyOnceWith('appUrlOpen', expect.any(Function))
  expect(m.getLaunchUrl).not.toHaveBeenCalled()
  send({ url: cold })
  expect(auth).toHaveBeenCalledTimes(2)
  expect(navigation).toHaveBeenCalledOnce()
  stopAuth()
  stopNavigation()
  send({ url: cold })
  expect(auth).toHaveBeenCalledTimes(2)
  const afterRemount = vi.fn()
  capacitorPlatform.authCallbacks!.subscribe(afterRemount, onError)()
  expect(afterRemount).toHaveBeenCalledExactlyOnceWith(cold)
  // The one OS subscription belongs to the app lifetime, not to a mounted login/shell view.
  expect(m.remove).not.toHaveBeenCalled()
  expect(onError).not.toHaveBeenCalled()
})

it('reports registration failure and rejects readiness instead of pretending callbacks can arrive', async () => {
  const failure = new Error('native URL registration failed')
  m.addListener.mockRejectedValueOnce(failure).mockResolvedValue({ remove: m.remove })
  const { nativeOpenedLinksReady, subscribeNativeOpenedLinks } = await import('../../../apps/desktop/src/platform/capacitorOpenedLinks')
  const onError = vi.fn()
  const stop = subscribeNativeOpenedLinks('auth', vi.fn(), onError)
  await expect(nativeOpenedLinksReady()).rejects.toBe(failure)
  expect(onError).toHaveBeenCalledExactlyOnceWith(failure)
  await expect(nativeOpenedLinksReady()).resolves.toBeUndefined()
  stop()
})

it('does not report an old asynchronous registration failure to an unsubscribed view', async () => {
  let reject!: (error: Error) => void
  m.addListener.mockReturnValue(new Promise((_resolve, fail) => { reject = fail }))
  const { nativeOpenedLinksReady, subscribeNativeOpenedLinks } = await import('../../../apps/desktop/src/platform/capacitorOpenedLinks')
  const onError = vi.fn()
  const stop = subscribeNativeOpenedLinks('auth', vi.fn(), onError)
  const readiness = nativeOpenedLinksReady()
  stop()
  reject(new Error('late failure'))
  await expect(readiness).rejects.toThrow('late failure')
  expect(onError).not.toHaveBeenCalled()
})
