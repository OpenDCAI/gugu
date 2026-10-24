import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PhoneOsState } from '../../../../apps/desktop/src/mobile/phone-device/phoneActionCatalog'

const native = vi.hoisted(() => ({ requestPermissions: vi.fn(), healthRequest: vi.fn(), openSettings: vi.fn(), dataRequest: vi.fn() }))
vi.mock('../../../../apps/desktop/src/mobile/phone-device/nativePhoneActions', () => ({ nativePhoneActions: native, HEALTH_TYPES: [] }))
vi.mock('../../../../apps/desktop/src/mobile/phone-device/phoneDataActions', async (original) => ({
  ...await original<typeof import('../../../../apps/desktop/src/mobile/phone-device/phoneDataActions')>(),
  nativePhoneData: { request: native.dataRequest },
}))
import { connectPhoneActionGroup, requestPhoneRequirement } from '../../../../apps/desktop/src/mobile/phone-device/phonePermissionActions'
import { effectiveGrants, readPhoneDeviceSettings } from '../../../../apps/desktop/src/mobile/phone-device/phoneDeviceSettings'

const values = new Map<string, string>()
function os(): PhoneOsState {
  return {
    runtime: { calendar: 'prompt', contacts: 'denied', location: 'prompt', coarseLocation: 'prompt' },
    special: { notification_listener: false, dnd_access: false, background_location: false, location_enabled: true, alarm_app: true, foreground: true },
    health: { supported: true, granted_types: [], background_supported: true, background_granted: false },
    data: { supported: true, sms: false, audio: false, images: false, videos: false, selected: false },
  }
}
beforeEach(() => {
  vi.clearAllMocks(); values.clear()
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) })
  native.requestPermissions.mockResolvedValue({ calendar: 'denied' }); native.openSettings.mockResolvedValue(undefined)
})
afterEach(() => vi.unstubAllGlobals())

describe('one permission action shared by phone guide and settings', () => {
  it('routes an irrevocable runtime denial to app settings and uses the request dialog while allowed', async () => {
    await requestPhoneRequirement('contacts', os())
    expect(native.openSettings).toHaveBeenCalledWith({ target: 'app' })
    expect(native.requestPermissions).not.toHaveBeenCalled()
    await requestPhoneRequirement('calendar', os())
    expect(native.requestPermissions).toHaveBeenCalledWith({ permissions: ['calendar'] })
  })
  it('routes notification reading and DND to separate special settings', async () => {
    await requestPhoneRequirement('notification_listener', os()); await requestPhoneRequirement('dnd_access', os())
    expect(native.openSettings.mock.calls).toEqual([[{ target: 'notification_listener' }], [{ target: 'dnd' }]])
  })
  it('preserves partial photo permission instead of forcing a full-library grant', async () => {
    native.dataRequest.mockResolvedValue({ supported: true, images: false, videos: false, selected: true })
    await requestPhoneRequirement('photos', os())
    expect(native.dataRequest).toHaveBeenCalledWith({ group: 'photos' })
    expect(native.openSettings).not.toHaveBeenCalled()
  })
  it('keeps phone capability opt-in independent of a rejected OS grant, which remains unavailable', async () => {
    const state = os()
    await connectPhoneActionGroup('explicit-calendar-owner', 'calendar', state, { enableDevice: true })
    expect(effectiveGrants(readPhoneDeviceSettings('explicit-calendar-owner')).calendar).toBe(true)
    expect(state.runtime.calendar).toBe('prompt')
    expect(readPhoneDeviceSettings('explicit-calendar-owner').hostEnabled).toBe(false)
  })
  it('does not touch any grant when OS state could not be read; native failures propagate', async () => {
    await expect(connectPhoneActionGroup('no-os-owner', 'calendar', null, { enableDevice: true })).rejects.toThrow('系统权限')
    expect(readPhoneDeviceSettings('no-os-owner').enabled).toBe(false)
    native.requestPermissions.mockRejectedValue(new Error('native unavailable'))
    await expect(requestPhoneRequirement('calendar', os())).rejects.toThrow('native unavailable')
  })
})
