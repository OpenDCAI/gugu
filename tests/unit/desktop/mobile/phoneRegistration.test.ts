import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({ deviceInfo: vi.fn() }))
vi.mock('../../../../apps/desktop/src/mobile/phone-device/nativePhoneActions', () => ({ nativePhoneActions: native }))
import { readPhoneInstallation } from '../../../../apps/desktop/src/mobile/phone-device/phoneInstallation'
import { phoneDeviceId, phoneInstallId } from '../../../../apps/desktop/src/mobile/phone-device/phoneDeviceSettings'

const KEY = '11111111-1111-4111-8111-111111111111'
const CURRENT = '22222222-2222-4222-8222-222222222222'
const OWNER = '33333333-3333-4333-8333-333333333333'
let values: Map<string, string>
beforeEach(() => {
  values = new Map()
  vi.stubGlobal('localStorage', {
    get length() { return values.size }, key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
  })
  native.deviceInfo.mockReset().mockResolvedValue({ install_key: KEY, registration_id: CURRENT })
})
afterEach(() => vi.unstubAllGlobals())

describe('native registration across WebView origins', () => {
  it('uses one device row with an existing cache, an empty origin, and a stale legacy origin', async () => {
    const ids = []
    for (const cached of [CURRENT, null, '44444444-4444-4444-8444-444444444444']) {
      values = new Map(cached ? [['gugu.phoneDevice.install', cached], ['gugu.phoneDevice.installBoundTo', KEY]] : [])
      const info = await readPhoneInstallation(OWNER)
      ids.push(phoneDeviceId(phoneInstallId(info.install_key!, info.registration_id!), OWNER))
      expect(values.get('gugu.phoneDevice.install')).toBe(CURRENT)
      expect(native.deviceInfo).toHaveBeenLastCalledWith({ ownerId: OWNER, cachedInstallId: cached, cachedBinding: cached ? KEY : null })
    }
    expect(new Set(ids)).toEqual(new Set([`phone-${CURRENT}-${OWNER}`]))
    expect(phoneDeviceId(CURRENT, 'another-owner')).not.toBe(ids[0])
  })

  it('does not write a fallback identity when native migration fails or the installed bridge is too old', async () => {
    native.deviceInfo.mockRejectedValueOnce(new Error('native migration failed'))
    await expect(readPhoneInstallation(OWNER)).rejects.toThrow('native migration failed')
    expect(values.size).toBe(0)
    expect(() => phoneInstallId(KEY, '')).toThrow('请更新手机安装包')
    expect(values.size).toBe(0)
  })
})
