// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({ addListener: vi.fn(), getState: vi.fn(), getInfo: vi.fn(), write: vi.fn() }))
vi.mock('@capacitor/app', () => ({ App: native }))
vi.mock('@capacitor/clipboard', () => ({ Clipboard: { write: native.write } }))
vi.mock('../../../../apps/desktop/src/lib/log', () => ({ rendererLogger: () => ({ error: vi.fn() }) }))
import { iosPlatform } from '../../../../apps/desktop/src/platform/ios'

beforeEach(() => { vi.resetAllMocks() })

describe('iOS foreground client', () => {
  it('does not expose Android host, market, update, watch, scan, share or notification entry points', () => {
    for (const key of ['phoneDevice', 'mobileApps', 'agentRuntime', 'appUpdates', 'backgroundWatch', 'barcodeScan', 'shareToApps', 'notifications', 'sessionHost'] as const) {
      expect(iosPlatform.capabilities[key], key).toBe(false)
    }
    expect(iosPlatform.authCallbacks).toBeUndefined()
    expect(iosPlatform.oauthBrowser).toBeUndefined()
    expect(iosPlatform.systemPermissions).toEqual([])
  })

  it('preserves a native clipboard failure instead of reporting a successful copy', async () => {
    const failure = new Error('clipboard refused')
    native.write.mockRejectedValueOnce(failure)
    await expect(iosPlatform.writeClipboardText('中文 😀')).rejects.toBe(failure)
    expect(native.write).toHaveBeenCalledWith({ string: '中文 😀' })
  })

  it('releases a resume listener even when registration finishes after unmount', async () => {
    let register!: (handle: { remove: () => Promise<void> }) => void
    native.addListener.mockReturnValueOnce(new Promise(resolve => { register = resolve }))
    const listener = vi.fn()
    const stop = iosPlatform.subscribeAppForeground(listener, vi.fn())
    stop()
    const remove = vi.fn().mockResolvedValue(undefined)
    register({ remove })
    await Promise.resolve()
    native.addListener.mock.calls[0][1]()
    expect(remove).toHaveBeenCalledOnce()
    expect(listener).not.toHaveBeenCalled()
  })

  it('does not overwrite a newer inactive event with a late initial state', async () => {
    let resolveState!: (state: { isActive: boolean }) => void
    native.getState.mockReturnValueOnce(new Promise(resolve => { resolveState = resolve }))
    const remove = vi.fn().mockResolvedValue(undefined)
    native.addListener.mockResolvedValueOnce({ remove })
    const listener = vi.fn()
    const stop = iosPlatform.subscribeAppActive!(listener)
    native.addListener.mock.calls[0][1]({ isActive: false })
    resolveState({ isActive: true })
    await Promise.resolve()
    expect(listener.mock.calls).toEqual([[false]])
    stop()
    expect(remove).toHaveBeenCalledOnce()
  })
})
