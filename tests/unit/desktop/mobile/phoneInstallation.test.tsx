// @vitest-environment jsdom
import { act, createElement, Fragment } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clickElement, createNode, createReactHarness, deferred, waitForCondition } from '../../../support/testHarness'

const mocks = vi.hoisted(() => ({
  owner: '', kind: 'capacitor', available: true, failBinding: false,
  deviceInfo: vi.fn(), start: vi.fn(), cleanup: vi.fn(),
  stopped: vi.fn(async (_ownerId: string) => undefined),
  grants: vi.fn(async (_input: { ownerId: string; calendar: boolean; groups: Record<string, boolean> }) => undefined),
}))
vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('../../../../apps/desktop/src/store/auth', async () => {
  const { createContext } = await import('react')
  return { AuthContext: createContext(null), useAuth: () => ({ user: { id: mocks.owner } }) }
})
vi.mock('../../../../apps/desktop/src/lib/sessionPublication', () => ({
  getRendererSession: () => ({ user: { id: mocks.owner } }), observeRendererSession: () => () => {},
}))
vi.mock('../../../../apps/desktop/src/lib/myAssistant', () => ({
  useMyAssistant: () => ({ agentId: null, provisionDeviceId: null, loading: false, error: null }),
}))
vi.mock('../../../../apps/desktop/src/lib/log', () => ({ rendererLogger: () => ({ error: vi.fn(), warn: vi.fn() }) }))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: {
  get kind() { return mocks.kind }, systemPermissions: [], subscribeAppForeground: () => () => {},
} }))
vi.mock('../../../../apps/desktop/src/mobile/backgroundWatchClaims', () => ({ claimBackgroundWatch: () => () => {} }))
vi.mock('../../../../apps/desktop/src/mobile/local-agent/nativeAgent', () => ({
  phoneAgentAvailable: () => mocks.available, nativeAgent: { grants: mocks.grants },
}))
vi.mock('../../../../apps/desktop/src/mobile/phone-device/nativePhoneActions', () => ({
  HEALTH_TYPES: ['steps', 'sleep'], nativePhoneActions: { deviceInfo: mocks.deviceInfo },
}))
vi.mock('../../../../apps/desktop/src/mobile/phone-device/phoneDeviceRuntime', () => ({
  startPhoneDevice: mocks.start, ensurePhoneAgentHostStopped: mocks.stopped,
  usePhoneDevice: () => ({ os: null, host: null, link: { state: 'off' } }),
  refreshPhoneDevice: async () => {}, stopPhoneAgentHost: async () => {}, restartPhoneAgentHost: async () => {},
}))

import { PhoneAgentSetupGate } from '../../../../apps/desktop/src/mobile/local-agent/PhoneAgentSetupGate'
import { PhoneAgentGrants } from '../../../../apps/desktop/src/mobile/local-agent/PhoneAgentGrants'
import { PhoneInstallationContext } from '../../../../apps/desktop/src/mobile/local-agent/PhoneInstallationContext'
import { savePhoneAgentSetup } from '../../../../apps/desktop/src/mobile/local-agent/PhoneAgentSetupState'
import { PhoneDeviceRoot } from '../../../../apps/desktop/src/mobile/phone-device/PhoneDeviceRoot'
import { phoneInstallId, readPhoneDeviceSettings, setPhoneActionGroup, setPhoneAgentHostEnabled, setPhoneDeviceEnabled } from '../../../../apps/desktop/src/mobile/phone-device/phoneDeviceSettings'

const values = new Map<string, string>()
const active: Array<ReturnType<typeof createReactHarness>> = []
const NATIVE_KEY = 'verified-native-phone'
function roots() { return createElement(Fragment, null, createNode(PhoneDeviceRoot), createNode(PhoneAgentGrants)) }
function app(ownerId: string) {
  return createNode(PhoneAgentSetupGate, { ownerId, children: createElement('main', { 'data-testid': 'basic-product' }, '基本 App', roots()) })
}
async function render(ownerId = mocks.owner) {
  const harness = createReactHarness(); active.push(harness)
  await harness.render(app(ownerId))
  return harness
}
function choose(ownerId = mocks.owner, hostEnabled = true) {
  const installId = phoneInstallId(NATIVE_KEY, 'verified-registration')
  setPhoneDeviceEnabled(ownerId, true)
  setPhoneAgentHostEnabled(ownerId, hostEnabled)
  setPhoneActionGroup(ownerId, 'calendar', true)
  savePhoneAgentSetup(ownerId, installId, { step: 'tools', dismissed: true, completed: true })
  return installId
}
function expectNoPhoneEffects() {
  expect(mocks.start).not.toHaveBeenCalled()
  expect(mocks.grants).not.toHaveBeenCalled()
  expect(mocks.stopped).not.toHaveBeenCalled()
}
beforeEach(() => {
  vi.clearAllMocks(); values.clear()
  mocks.owner = crypto.randomUUID(); mocks.kind = 'capacitor'; mocks.available = true; mocks.failBinding = false
  mocks.start.mockImplementation(() => mocks.cleanup)
  mocks.grants.mockResolvedValue(undefined); mocks.stopped.mockResolvedValue(undefined)
  mocks.deviceInfo.mockReset().mockResolvedValue({ install_key: NATIVE_KEY, registration_id: 'verified-registration' })
  vi.stubGlobal('localStorage', {
    get length() { return values.size }, key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (mocks.failBinding && key === 'gugu.phoneDevice.installBoundTo') throw new Error('cannot persist native binding')
      values.set(key, value)
    },
    removeItem: (key: string) => { values.delete(key) }, clear: () => values.clear(),
  })
})
afterEach(() => { for (const harness of active.splice(0)) harness.cleanup(); vi.unstubAllGlobals() })

describe('native installation verification gates the actual phone effect roots', () => {
  it('does nothing without a verified-installation provider, even with saved enabled choices', async () => {
    choose()
    const harness = createReactHarness(); active.push(harness)
    await harness.render(roots())
    expectNoPhoneEffects()
    expect(mocks.deviceInfo).not.toHaveBeenCalled()
  })

  it('keeps the basic app mounted and starts neither grants nor stop/start while verification is pending', async () => {
    choose()
    const reading = deferred<{ install_key: string; registration_id?: string }>()
    mocks.deviceInfo.mockReturnValue(reading.promise)
    const harness = await render()
    expect(harness.container.querySelector('[data-testid="basic-product"]')).not.toBeNull()
    expectNoPhoneEffects()
    await act(async () => reading.resolve({ install_key: NATIVE_KEY, registration_id: 'verified-registration' }))
    await waitForCondition(() => mocks.start.mock.calls.length === 1, 'verified settings may start the phone')
    expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({ userId: mocks.owner, hostEnabled: true }))
    expect(mocks.grants).toHaveBeenCalledWith(expect.objectContaining({ ownerId: mocks.owner, calendar: true }))
    expect(mocks.stopped).not.toHaveBeenCalled()
  })

  it('clears restored cached choices before either root can use them on a different native install', async () => {
    const oldInstall = choose()
    expect(readPhoneDeviceSettings(mocks.owner).hostEnabled).toBe(true)
    const reading = deferred<{ install_key: string; registration_id?: string }>()
    mocks.deviceInfo.mockReturnValue(reading.promise)
    await render()
    expectNoPhoneEffects()
    await act(async () => reading.resolve({ install_key: 'restored-on-another-native-phone', registration_id: 'new-registration' }))
    await waitForCondition(() => mocks.grants.mock.calls.length > 0, 'verified reset reaches the native mirror')
    expect(values.get('gugu.phoneDevice.install')).not.toBe(oldInstall)
    expect(readPhoneDeviceSettings(mocks.owner)).toMatchObject({ enabled: false, hostEnabled: false })
    expect(mocks.start).not.toHaveBeenCalled()
    for (const [call] of mocks.grants.mock.calls) expect(Object.values(call.groups).every((value) => !value)).toBe(true)
    expect(mocks.stopped).toHaveBeenCalledExactlyOnceWith(mocks.owner)
  })

  it('uses native continuity evidence to preserve a normal upgrade before effects start', async () => {
    const installation = choose()
    mocks.deviceInfo.mockResolvedValue({ install_key: 'new-no-backup-install-key', previous_install_key: NATIVE_KEY, registration_id: 'verified-registration' })
    await render()
    await waitForCondition(() => mocks.start.mock.calls.length === 1, 'native-proven upgrade starts saved host')
    expect(values.get('gugu.phoneDevice.install')).toBe(installation)
    expect(values.get('gugu.phoneDevice.installBoundTo')).toBe('new-no-backup-install-key')
    expect(mocks.grants).toHaveBeenCalledWith(expect.objectContaining({ ownerId: mocks.owner, calendar: true }))
  })

  it('keeps effects closed for a missing native key after the user dismisses the error sheet', async () => {
    choose()
    mocks.deviceInfo.mockResolvedValue({ install_key: '   ' })
    const harness = await render()
    await waitForCondition(() => document.querySelector('[role="alert"]')?.textContent?.includes('读取这台手机') === true, 'native verification error')
    expect(harness.container.querySelector('[data-testid="basic-product"]')).not.toBeNull()
    expectNoPhoneEffects()
    const later = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '先使用咕咕')!
    await clickElement(later)
    expectNoPhoneEffects()
  })

  it('lets the user retry a failed native read before the saved same-install choices start', async () => {
    choose()
    mocks.deviceInfo.mockRejectedValueOnce(new Error('native read failed'))
    await render()
    await waitForCondition(() => document.querySelector('[role="alert"]') !== null, 'native read error')
    expectNoPhoneEffects()
    const retry = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '重试')!
    await clickElement(retry)
    await waitForCondition(() => mocks.start.mock.calls.length === 1, 'retry verified the actual installation')
    expect(mocks.deviceInfo).toHaveBeenCalledTimes(2)
    expect(mocks.grants).toHaveBeenCalledWith(expect.objectContaining({ ownerId: mocks.owner, calendar: true }))
    expect(mocks.stopped).not.toHaveBeenCalled()
  })

  it('does not publish a verified owner when persisting the new installation binding fails', async () => {
    choose(); mocks.failBinding = true
    mocks.deviceInfo.mockResolvedValue({ install_key: 'binding-write-fails', registration_id: 'registration-binding-write-fails' })
    await render()
    await waitForCondition(() => document.querySelector('[role="alert"]') !== null, 'binding persistence failure')
    expectNoPhoneEffects()
  })

  it('ignores an old owner native response before it can rotate the current installation or start effects', async () => {
    choose()
    const previous = deferred<{ install_key: string; registration_id?: string }>(), current = deferred<{ install_key: string; registration_id?: string }>()
    mocks.deviceInfo.mockReturnValueOnce(previous.promise).mockReturnValueOnce(current.promise)
    const harness = await render()
    const previousOwner = mocks.owner
    mocks.owner = crypto.randomUUID(); choose()
    await harness.render(app(mocks.owner))
    await act(async () => previous.resolve({ install_key: 'stale-native-key' }))
    expectNoPhoneEffects()
    expect(values.get('gugu.phoneDevice.installBoundTo')).toBe(NATIVE_KEY)
    await act(async () => current.resolve({ install_key: NATIVE_KEY, registration_id: 'verified-registration' }))
    await waitForCondition(() => mocks.start.mock.calls.length === 1, 'current owner verified')
    expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({ userId: mocks.owner }))
    expect(mocks.grants.mock.calls.some(([call]) => call.ownerId === previousOwner)).toBe(false)
  })

  it('verifies the installation for action-only older Apps without a Pi plugin', async () => {
    choose(mocks.owner, false); mocks.available = false
    await render()
    await waitForCondition(() => mocks.start.mock.calls.length === 1, 'legacy phone actions may start after verification')
    expect(mocks.deviceInfo).toHaveBeenCalledOnce()
    expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({ userId: mocks.owner, hostEnabled: false }))
    expect(mocks.grants).not.toHaveBeenCalled()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('never treats a different logged-in owner as verified and retains the old root cleanup', async () => {
    choose()
    const harness = createReactHarness(); active.push(harness)
    const previousOwner = mocks.owner
    const tree = () => createElement(PhoneInstallationContext.Provider, { value: previousOwner }, roots())
    await harness.render(tree())
    expect(mocks.start).toHaveBeenCalledOnce()
    mocks.owner = crypto.randomUUID(); choose()
    await harness.render(tree())
    expect(mocks.cleanup).toHaveBeenCalledOnce()
    expect(mocks.start).toHaveBeenCalledOnce()
    expect(mocks.stopped).not.toHaveBeenCalled()
    expect(mocks.grants.mock.calls.some(([call]) => call.ownerId === mocks.owner)).toBe(false)
    expect(mocks.grants).toHaveBeenLastCalledWith(expect.objectContaining({ ownerId: previousOwner, calendar: false }))
  })

  it('keeps non-Capacitor Apps usable without reading a native installation', async () => {
    choose(); mocks.kind = 'electron'
    const harness = await render()
    expect(harness.container.querySelector('[data-testid="basic-product"]')).not.toBeNull()
    expect(mocks.deviceInfo).not.toHaveBeenCalled()
    expectNoPhoneEffects()
  })
})
