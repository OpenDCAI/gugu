import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  native: vi.fn(), syncTone: vi.fn(), tone: vi.fn(), preference: vi.fn(),
  subscribeTone: vi.fn(), subscribePreference: vi.fn(),
}))
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: mocks.native }, registerPlugin: () => ({ syncTone: mocks.syncTone }),
}))
vi.mock('../../../apps/desktop/src/session/renderer/lib/theme/host-theme', () => ({
  readEffectiveHostTheme: mocks.tone, readThemePreference: mocks.preference,
  subscribeToHostTheme: mocks.subscribeTone, subscribeToThemePreference: mocks.subscribePreference,
}))
vi.mock('../../../apps/desktop/src/lib/log', () => ({ rendererLogger: () => ({ error: vi.fn() }) }))
import { startShellChromeTone } from '../../../apps/desktop/src/platform/capacitorShellChrome'

describe('native startup theme mirror', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.native.mockReturnValue(true)
    mocks.syncTone.mockResolvedValue(undefined)
    mocks.tone.mockReturnValue('dark')
    mocks.preference.mockReturnValue('dark')
  })

  it('sends both the stored preference and resolved initial tone', () => {
    startShellChromeTone()
    expect(mocks.syncTone).toHaveBeenCalledWith({ preference: 'dark', tone: 'dark' })
  })

  it('mirrors a move to system even when the effective tone stays dark', () => {
    startShellChromeTone()
    mocks.preference.mockReturnValue('system')
    mocks.subscribePreference.mock.calls[0][0]()
    expect(mocks.syncTone).toHaveBeenLastCalledWith({ preference: 'system', tone: 'dark' })
  })

  it('does not install native behavior in the web client', () => {
    mocks.native.mockReturnValue(false)
    startShellChromeTone()
    expect(mocks.syncTone).not.toHaveBeenCalled()
    expect(mocks.subscribePreference).not.toHaveBeenCalled()
  })
})
