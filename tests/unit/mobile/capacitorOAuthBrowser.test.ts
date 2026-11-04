import { beforeEach, describe, expect, it, vi } from 'vitest'
import { openBrowser, subscribeBrowserFinished } from '../../../apps/desktop/src/platform/capacitorOAuthBrowser'

const browser = vi.hoisted(() => ({ open: vi.fn(), addListener: vi.fn(), remove: vi.fn() }))
vi.mock('@capacitor/browser', () => ({ Browser: browser }))

beforeEach(() => {
  vi.resetAllMocks()
  browser.open.mockResolvedValue(undefined)
  browser.remove.mockResolvedValue(undefined)
  browser.addListener.mockResolvedValue({ remove: browser.remove })
})

describe('Android OAuth browser boundary', () => {
  it('opens the HTTPS authorization URL in the native browser and awaits its result', async () => {
    const url = 'https://auth.example.test/auth/v1/authorize?provider=google&redirect_to=gugu-beta%3A%2F%2Fauth%2Fcallback&code_challenge=a%2Bb'
    let resolve!: () => void
    browser.open.mockReturnValue(new Promise<void>((done) => { resolve = done }))
    let settled = false
    const opening = openBrowser(url).then(() => { settled = true })
    expect(browser.open).toHaveBeenCalledExactlyOnceWith({ url })
    await Promise.resolve()
    expect(settled).toBe(false)
    resolve()
    await opening
    expect(settled).toBe(true)
  })

  it.each(['invalid-private-value', 'javascript:alert(1)', 'http://auth.example.test', 'gugu-beta://auth/callback', 'https://user:private@auth.example.test'])('rejects an invalid authorization target without opening it: %s', async (url) => {
    await expect(openBrowser(url)).rejects.toThrow('Invalid authorization URL')
    expect(browser.open).not.toHaveBeenCalled()
  })

  it('propagates native browser-open failure to the interactive flow', async () => {
    const failure = new Error('No browser available')
    browser.open.mockRejectedValue(failure)
    await expect(openBrowser('https://auth.example.test/authorize')).rejects.toBe(failure)
  })

  it('does not become ready until native listener registration completes', async () => {
    let register!: () => void
    browser.addListener.mockReturnValue(new Promise((resolve) => {
      register = () => resolve({ remove: browser.remove })
    }))
    let ready = false
    const subscribed = subscribeBrowserFinished(vi.fn(), vi.fn()).then((stop) => { ready = true; return stop })
    await Promise.resolve()
    expect(ready).toBe(false)
    expect(browser.addListener).toHaveBeenCalledExactlyOnceWith('browserFinished', expect.any(Function))
    register()
    const stop = await subscribed
    expect(ready).toBe(true)
    stop()
    await vi.waitFor(() => expect(browser.remove).toHaveBeenCalledOnce())
  })

  it('rejects registration failure so authorization cannot proceed without cancellation events', async () => {
    const failure = new Error('Native registration failed')
    browser.addListener.mockRejectedValue(failure)
    await expect(subscribeBrowserFinished(vi.fn(), vi.fn())).rejects.toBe(failure)
    expect(browser.open).not.toHaveBeenCalled()
  })

  it('reports browser closure and suppresses late delivery immediately after idempotent cleanup', async () => {
    let finished!: () => void
    browser.addListener.mockImplementation(async (_event, listener: () => void) => {
      finished = listener
      return { remove: browser.remove }
    })
    let finishRemoval!: () => void
    browser.remove.mockReturnValue(new Promise<void>((resolve) => { finishRemoval = resolve }))
    const listener = vi.fn(), onError = vi.fn()
    const stop = await subscribeBrowserFinished(listener, onError)
    finished()
    expect(listener).toHaveBeenCalledOnce()
    stop()
    stop()
    finished()
    expect(listener).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(browser.remove).toHaveBeenCalledOnce())
    finishRemoval()
    expect(onError).not.toHaveBeenCalled()
  })

  it.each(['reject', 'throw'])('reports native cleanup failure (%s) without reactivating stale delivery', async (mode) => {
    let finished!: () => void
    browser.addListener.mockImplementation(async (_event, listener: () => void) => {
      finished = listener
      return { remove: browser.remove }
    })
    const failure = new Error('Native removal failed')
    browser.remove.mockImplementation(() => {
      if (mode === 'throw') throw failure
      return Promise.reject(failure)
    })
    const listener = vi.fn(), onError = vi.fn()
    const stop = await subscribeBrowserFinished(listener, onError)
    stop()
    await vi.waitFor(() => expect(onError).toHaveBeenCalledExactlyOnceWith(failure))
    finished()
    expect(listener).not.toHaveBeenCalled()
  })

  it('routes listener errors to the shared flow instead of losing a native callback exception', async () => {
    let finished!: () => void
    browser.addListener.mockImplementation(async (_event, listener: () => void) => {
      finished = listener
      return { remove: browser.remove }
    })
    const failure = new Error('Flow handling failed')
    const onError = vi.fn()
    const stop = await subscribeBrowserFinished(() => { throw failure }, onError)
    finished()
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure)
    stop()
    await vi.waitFor(() => expect(browser.remove).toHaveBeenCalledOnce())
  })
})
