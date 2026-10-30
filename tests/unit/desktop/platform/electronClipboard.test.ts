// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { electronPlatform } from '@/platform/electron'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
describe('Electron clipboard transport', () => {
  it('uses its existing native bridge without writing through the renderer', async () => {
    const native = vi.fn(async () => true), browser = vi.fn()
    vi.stubGlobal('navigator', { clipboard: { writeText: browser } })
    vi.stubGlobal('window', { electronAPI: { writeClipboardText: native } })
    await electronPlatform.writeClipboardText('桌面 中文\nexact')
    expect(native).toHaveBeenCalledExactlyOnceWith('桌面 中文\nexact')
    expect(browser).not.toHaveBeenCalled()
  })
  it('retains browser transport when its native bridge is absent', async () => {
    const browser = vi.fn(async () => {})
    vi.stubGlobal('navigator', { clipboard: { writeText: browser } })
    vi.stubGlobal('window', {})
    await electronPlatform.writeClipboardText('fallback')
    expect(browser).toHaveBeenCalledExactlyOnceWith('fallback')
  })
  it('does not turn a native refusal into browser success', async () => {
    const error = new Error('native refused'), browser = vi.fn()
    vi.stubGlobal('navigator', { clipboard: { writeText: browser } })
    vi.stubGlobal('window', { electronAPI: { writeClipboardText: vi.fn().mockRejectedValue(error) } })
    await expect(electronPlatform.writeClipboardText('refused')).rejects.toBe(error)
    expect(browser).not.toHaveBeenCalled()
  })
})
