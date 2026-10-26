import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectiveGrants, phoneInstallId, readPhoneDeviceSettings, setPhoneActionGroup, setPhoneAgentHostEnabled, setPhoneDeviceEnabled, subscribePhoneDeviceSettings } from '../../../../apps/desktop/src/mobile/phone-device/phoneDeviceSettings'

const values = new Map<string, string>()
beforeEach(() => {
  values.clear()
  vi.stubGlobal('localStorage', { get length() { return values.size }, key: (index: number) => [...values.keys()][index] ?? null, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } })
})

describe('consent belongs to the verified native installation', () => {
  it('resets every restored account and cached choice before binding a different phone', () => {
    const previous = phoneInstallId('source-phone', 'registration-source-phone')
    for (const owner of ['cached-install-owner-a', 'cached-install-owner-b']) {
      setPhoneDeviceEnabled(owner, true)
      setPhoneAgentHostEnabled(owner, true)
      setPhoneActionGroup(owner, 'alarm', true)
    }
    values.set('gugu.phoneDevice.v1:unread-restored-owner', JSON.stringify({ enabled: true, hostEnabled: true, groups: { sms: true } }))
    values.set('unrelated-task-record', 'preserve-me')
    const notified = vi.fn()
    const unsubscribe = subscribePhoneDeviceSettings(notified)
    try {
      const current = phoneInstallId('destination-phone', 'registration-destination-phone')
      expect(current).not.toBe(previous)
      for (const owner of ['cached-install-owner-a', 'cached-install-owner-b', 'unread-restored-owner']) {
        const settings = readPhoneDeviceSettings(owner)
        expect(settings).toMatchObject({ enabled: false, hostEnabled: false })
        expect(Object.values(settings.groups).every((value) => !value)).toBe(true)
        expect(JSON.parse(values.get('gugu.phoneDevice.v1:' + owner)!)).toMatchObject({ enabled: false, hostEnabled: false })
      }
      expect(notified).toHaveBeenCalledOnce()
      expect(values.get('unrelated-task-record')).toBe('preserve-me')
      expect(phoneInstallId('destination-phone', 'registration-destination-phone')).toBe(current)
    } finally { unsubscribe() }
  })

  it('keeps existing choices on an upgrade with the same verified native key', () => {
    const owner = 'same-install-consent-owner', installation = phoneInstallId('unchanged-phone', 'registration-unchanged-phone')
    setPhoneDeviceEnabled(owner, true)
    setPhoneAgentHostEnabled(owner, true)
    setPhoneActionGroup(owner, 'calendar', true)
    expect(phoneInstallId('unchanged-phone', 'registration-unchanged-phone')).toBe(installation)
    expect(readPhoneDeviceSettings(owner)).toMatchObject({ enabled: true, hostEnabled: true, groups: { calendar: true } })
  })

  it('does not accept an unbound legacy copy as consent on this native phone', () => {
    values.set('gugu.phoneDevice.install', 'legacy-unverified-install')
    values.set('gugu.phoneDevice.v1:legacy-restored-consent', JSON.stringify({ enabled: true, hostEnabled: true, groups: { contacts: true } }))
    expect(phoneInstallId('actual-native-phone', 'registration-actual-native-phone')).not.toBe('legacy-unverified-install')
    expect(readPhoneDeviceSettings('legacy-restored-consent')).toMatchObject({ enabled: false, hostEnabled: false, groups: { contacts: false } })
  })

  it('migrates a native-proven upgrade without changing its device identity or consent', () => {
    const owner = 'native-proven-upgrade', installation = phoneInstallId('legacy-device-key', 'registration-legacy-device-key')
    setPhoneDeviceEnabled(owner, true)
    setPhoneAgentHostEnabled(owner, true)
    setPhoneActionGroup(owner, 'calendar', true)
    expect(phoneInstallId('native-install-nonce', installation, 'legacy-device-key')).toBe(installation)
    expect(values.get('gugu.phoneDevice.installBoundTo')).toBe('native-install-nonce')
    expect(readPhoneDeviceSettings(owner)).toMatchObject({ enabled: true, hostEnabled: true, groups: { calendar: true } })
    expect(phoneInstallId('native-install-nonce', installation)).toBe(installation)
  })

  it('does not migrate restored consent when the native upgrade alias differs', () => {
    const installation = phoneInstallId('restored-device-key', 'registration-restored-device-key')
    setPhoneDeviceEnabled('restored-with-alias', true)
    setPhoneAgentHostEnabled('restored-with-alias', true)
    expect(phoneInstallId('new-install-nonce', 'registration-new-install-nonce', 'another-old-key')).not.toBe(installation)
    expect(readPhoneDeviceSettings('restored-with-alias')).toMatchObject({ enabled: false, hostEnabled: false })
  })

  it('does not commit a new binding when revoking stored consent fails, and can retry', () => {
    const owner = 'durable-rebind-owner', installation = phoneInstallId('original-native-phone', 'registration-original-native-phone')
    setPhoneDeviceEnabled(owner, true)
    setPhoneAgentHostEnabled(owner, true)
    setPhoneActionGroup(owner, 'calendar', true)
    const original = localStorage.setItem
    vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === 'gugu.phoneDevice.v1:' + owner) throw new Error('storage unavailable')
      original.call(localStorage, key, value)
    })
    expect(() => phoneInstallId('restored-native-phone', 'registration-restored-native-phone')).toThrow()
    expect(values.get('gugu.phoneDevice.install')).toBe(installation)
    expect(values.get('gugu.phoneDevice.installBoundTo')).toBe('original-native-phone')
    expect(readPhoneDeviceSettings(owner)).toMatchObject({ enabled: false, hostEnabled: false })
    vi.mocked(localStorage.setItem).mockRestore()
    expect(phoneInstallId('restored-native-phone', 'registration-restored-native-phone')).not.toBe(installation)
    expect(JSON.parse(values.get('gugu.phoneDevice.v1:' + owner)!)).toMatchObject({ enabled: false, hostEnabled: false })
  })
})
afterEach(() => vi.unstubAllGlobals())

describe('agent hosting and phone data access are independent owner choices', () => {
  it('does not auto-enable the host when upgrading an action-enabled phone', () => {
    values.set('gugu.phoneDevice.v1:legacy-owner', JSON.stringify({ enabled: true, groups: { calendar: true } }))
    expect(readPhoneDeviceSettings('legacy-owner')).toMatchObject({ enabled: true, hostEnabled: false })
    expect(effectiveGrants(readPhoneDeviceSettings('legacy-owner')).calendar).toBe(true)
  })
  it('enabling a host grants no data; stopping it leaves existing device grants intact', () => {
    const owner = 'host-owner'
    setPhoneAgentHostEnabled(owner, true)
    setPhoneActionGroup(owner, 'calendar', true)
    expect(readPhoneDeviceSettings(owner)).toMatchObject({ hostEnabled: true, enabled: false })
    expect(Object.values(effectiveGrants(readPhoneDeviceSettings(owner))).every((granted) => !granted)).toBe(true)
    setPhoneDeviceEnabled(owner, true)
    expect(effectiveGrants(readPhoneDeviceSettings(owner)).calendar).toBe(true)
    setPhoneAgentHostEnabled(owner, false)
    expect(readPhoneDeviceSettings(owner)).toMatchObject({ enabled: true, hostEnabled: false, groups: { calendar: true } })
    expect(effectiveGrants(readPhoneDeviceSettings(owner)).calendar).toBe(true)
    expect(readPhoneDeviceSettings('another-owner')).toMatchObject({ enabled: false, hostEnabled: false })
  })
})
