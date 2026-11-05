import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  startupContext: vi.fn(), startupFrame: vi.fn(), startupReactCommit: vi.fn(),
  startupContentReady: vi.fn(), startupFailed: vi.fn(), startupClock: vi.fn(), startupTiming: vi.fn(),
  platform: vi.fn(),
}))
vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: mocks.platform }, registerPlugin: () => mocks,
}))
vi.mock('../../../apps/desktop/src/lib/log', () => ({ rendererLogger: () => ({ error: vi.fn() }) }))

const deferred = <T = void>() => {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
const makeApi = () => {
  const frame = deferred()
  const handle = { frameReady: frame.promise, reveal: vi.fn() }
  let ready = () => {}
  return {
    defer: vi.fn(), start: vi.fn(() => handle as typeof handle | null), discard: vi.fn(),
    onContentReady: vi.fn((listener: () => void) => { ready = listener; return vi.fn() }),
    ready: () => ready(), frame, handle,
  }
}

describe('Android startup visual handoff', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.resetAllMocks()
    mocks.platform.mockReturnValue('android')
    mocks.startupContext.mockResolvedValue({ enabled: true, attemptId: 'current', tone: 'dark' })
    for (const name of ['startupFrame', 'startupReactCommit', 'startupContentReady', 'startupFailed', 'startupTiming'] as const)
      mocks[name].mockResolvedValue(undefined)
    mocks.startupClock.mockResolvedValue({ elapsedMs: 1000 })
    vi.stubGlobal('window', Object.assign(new EventTarget(), { localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } }))
    vi.stubGlobal('performance', { now: () => 10, getEntriesByType: () => [] })
  })

  it('reserves the host before awaiting native and uses the frozen launch palette', async () => {
    const ctx = deferred<{ enabled: boolean; attemptId: string; tone: 'light' }>()
    mocks.startupContext.mockReturnValue(ctx.promise)
    const api = makeApi()
    const { bootstrapAndroidStartup } = await import('../../../apps/desktop/src/platform/androidStartupHandoff')
    const pending = bootstrapAndroidStartup(api)
    expect(api.defer).toHaveBeenCalledOnce()
    expect(api.onContentReady).toHaveBeenCalledOnce()
    expect(api.start).not.toHaveBeenCalled()
    ctx.resolve({ enabled: true, attemptId: 'light-launch', tone: 'light' })
    await tick()
    expect(api.start).toHaveBeenCalledWith({ initialPhase: 'assemble', hold: true,
      attemptId: 'light-launch', palette: { background: '#FFFFFF', foregroundRgb: '24,24,24' } })
    api.frame.resolve()
    await pending
  })

  it('starts the entrance clock only after native has removed its actual surface', async () => {
    const nativeRemoved = deferred()
    mocks.startupFrame.mockReturnValue(nativeRemoved.promise)
    const api = makeApi()
    const { bootstrapAndroidStartup } = await import('../../../apps/desktop/src/platform/androidStartupHandoff')
    const pending = bootstrapAndroidStartup(api)
    await tick()
    expect(mocks.startupFrame).not.toHaveBeenCalled()
    api.frame.resolve()
    await tick()
    expect(mocks.startupFrame).toHaveBeenCalledWith({ attemptId: 'current', kind: 'motion' })
    expect(api.handle.reveal).not.toHaveBeenCalled()
    nativeRemoved.resolve()
    await pending
    expect(api.handle.reveal).toHaveBeenCalledOnce()
  })

  it('fast real content wins while native context is still pending', async () => {
    const ctx = deferred<{ enabled: boolean; attemptId: string; tone: 'dark' }>()
    mocks.startupContext.mockReturnValue(ctx.promise)
    const api = makeApi()
    const { bootstrapAndroidStartup } = await import('../../../apps/desktop/src/platform/androidStartupHandoff')
    const pending = bootstrapAndroidStartup(api)
    api.ready()
    ctx.resolve({ enabled: true, attemptId: 'fast', tone: 'dark' })
    await pending
    expect(api.start).not.toHaveBeenCalled()
    expect(mocks.startupContentReady).toHaveBeenCalledWith({ attemptId: 'fast' })
  })

  it('content arriving during native handoff never replays the brand', async () => {
    const removed = deferred()
    mocks.startupFrame.mockReturnValue(removed.promise)
    const api = makeApi()
    const { bootstrapAndroidStartup } = await import('../../../apps/desktop/src/platform/androidStartupHandoff')
    const pending = bootstrapAndroidStartup(api)
    await tick(); api.frame.resolve(); await tick()
    api.ready(); api.ready(); removed.resolve()
    await pending
    expect(api.handle.reveal).not.toHaveBeenCalled()
    expect(mocks.startupContentReady).toHaveBeenCalledOnce()
  })

  it('null means content already won, so no artificial brand wait is introduced', async () => {
    const api = makeApi(); api.start.mockReturnValue(null)
    const { bootstrapAndroidStartup } = await import('../../../apps/desktop/src/platform/androidStartupHandoff')
    await bootstrapAndroidStartup(api)
    expect(mocks.startupContentReady).toHaveBeenCalledOnce()
    expect(mocks.startupFrame).not.toHaveBeenCalled()
  })

  it('local OFF discards the new surface and keeps the existing loader path', async () => {
    mocks.startupContext.mockResolvedValue({ enabled: false, attemptId: 'off', tone: 'light' })
    const api = makeApi()
    const { bootstrapAndroidStartup } = await import('../../../apps/desktop/src/platform/androidStartupHandoff')
    await bootstrapAndroidStartup(api)
    expect(api.discard).toHaveBeenCalledOnce()
    expect(api.start).not.toHaveBeenCalled()
    expect(mocks.startupFrame).not.toHaveBeenCalled()
  })

  it('an older shell with no context API falls back without trapping Web', async () => {
    mocks.startupContext.mockRejectedValue(new Error('not implemented'))
    const api = makeApi()
    const { bootstrapAndroidStartup } = await import('../../../apps/desktop/src/platform/androidStartupHandoff')
    await bootstrapAndroidStartup(api)
    expect(api.discard).toHaveBeenCalledOnce()
    expect(api.start).not.toHaveBeenCalled()
  })

  it('a real brand/font/draw failure reaches the native local recovery surface', async () => {
    const api = makeApi()
    const { bootstrapAndroidStartup } = await import('../../../apps/desktop/src/platform/androidStartupHandoff')
    const pending = bootstrapAndroidStartup(api)
    await tick(); api.frame.reject(new Error('font failed'))
    await pending
    expect(api.discard).toHaveBeenCalledOnce()
    expect(mocks.startupFailed).toHaveBeenCalledWith({ attemptId: 'current', reason: 'brand_frame_failed' })
    expect(api.handle.reveal).not.toHaveBeenCalled()
  })

  it('page destruction suppresses a late frame or ACK', async () => {
    const api = makeApi()
    const { bootstrapAndroidStartup } = await import('../../../apps/desktop/src/platform/androidStartupHandoff')
    const pending = bootstrapAndroidStartup(api)
    await tick(); window.dispatchEvent(new Event('pagehide')); api.frame.resolve()
    await pending
    expect(api.handle.reveal).not.toHaveBeenCalled()
    expect(mocks.startupFrame).not.toHaveBeenCalled()
  })

  it('retains a main module load failure until the matching native context arrives', async () => {
    const ctx = deferred<{ enabled: boolean; attemptId: string; tone: 'dark' }>()
    mocks.startupContext.mockReturnValue(ctx.promise)
    const listen = vi.spyOn(window, 'addEventListener')
    const api = makeApi()
    const { bootstrapAndroidStartup } = await import('../../../apps/desktop/src/platform/androidStartupHandoff')
    const pending = bootstrapAndroidStartup(api)
    const listener = listen.mock.calls.find(call => call[0] === 'error')![1] as EventListener
    listener({ target: { tagName: 'SCRIPT', type: 'module', src: '/assets/main.js' } } as unknown as Event)
    ctx.resolve({ enabled: true, attemptId: 'early-error', tone: 'dark' })
    await pending
    expect(api.start).not.toHaveBeenCalled()
    expect(mocks.startupFailed).toHaveBeenCalledWith({ attemptId: 'early-error', reason: 'main_module_load_failed' })
  })

  it('does not mistake ordinary business JS errors for a broken main module', async () => {
    const listen = vi.spyOn(window, 'addEventListener')
    const api = makeApi()
    const { bootstrapAndroidStartup } = await import('../../../apps/desktop/src/platform/androidStartupHandoff')
    const pending = bootstrapAndroidStartup(api)
    const listener = listen.mock.calls.find(call => call[0] === 'error')![1] as EventListener
    listener({ target: window } as unknown as Event)
    api.frame.resolve(); await pending
    expect(mocks.startupFailed).not.toHaveBeenCalled()
    expect(api.handle.reveal).toHaveBeenCalledOnce()
  })

  it('StrictMode or resume cannot create a second bootstrap', async () => {
    const api = makeApi()
    const { bootstrapAndroidStartup } = await import('../../../apps/desktop/src/platform/androidStartupHandoff')
    const first = bootstrapAndroidStartup(api), second = bootstrapAndroidStartup(api)
    expect(first).toBe(second)
    api.frame.resolve(); await first
    expect(api.defer).toHaveBeenCalledOnce(); expect(api.start).toHaveBeenCalledOnce()
  })

  it('React commit has its own signal and never waits for diagnostic timing', async () => {
    mocks.startupClock.mockReturnValue(new Promise(() => {}))
    const { reportAndroidStartupFrame } = await import('../../../apps/desktop/src/platform/androidStartupHandoff')
    await reportAndroidStartupFrame(); await reportAndroidStartupFrame()
    expect(mocks.startupReactCommit).toHaveBeenCalledOnce()
    expect(mocks.startupFrame).not.toHaveBeenCalled()
    expect(mocks.startupContentReady).not.toHaveBeenCalled()
  })

  it('a rejected diagnostic clock cannot reject or stall the real visual handoff', async () => {
    mocks.startupClock.mockRejectedValue(new Error('clock unavailable'))
    const api = makeApi()
    const { bootstrapAndroidStartup } = await import('../../../apps/desktop/src/platform/androidStartupHandoff')
    const pending = bootstrapAndroidStartup(api)
    api.frame.resolve(); await pending
    expect(api.handle.reveal).toHaveBeenCalledOnce()
    expect(mocks.startupFailed).not.toHaveBeenCalled()
  })
})
