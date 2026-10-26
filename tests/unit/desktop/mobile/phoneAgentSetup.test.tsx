// @vitest-environment jsdom
import { act, createElement, useContext, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../../../apps/desktop/src/lib/myAssistant', () => ({
  useMyAssistant: () => ({ agentId: null, provisionDeviceId: null, loading: false, error: null }),
}))
import { clickElement, createNode, createReactHarness, waitForCondition } from '../../../support/testHarness'
import type { PhoneAgentHostState } from '../../../../apps/desktop/src/mobile/local-agent/nativeAgent'
import type { PhoneOsState } from '../../../../apps/desktop/src/mobile/phone-device/phoneActionCatalog'

const mocks = vi.hoisted(() => ({
  permissions: ['notifications', 'batteryOptimization', 'camera'], host: null as PhoneAgentHostState | null, restartHost: vi.fn(),
  owner: 'setup-owner', installKey: 'native-install-a', available: true,
  runtimeRequest: vi.fn(async () => ({})), dataRequest: vi.fn(async () => ({})), healthRequest: vi.fn(), nativeSettings: vi.fn(async () => undefined),
  check: vi.fn(async (_permission: string) => 'prompt'), request: vi.fn(async () => 'blocked'), settings: vi.fn(async () => true),
  foreground: [] as Array<() => void>,
  os: null as PhoneOsState | null,
  refresh: vi.fn(async () => undefined),
}))
vi.mock('../../../../apps/desktop/src/mobile/local-agent/nativeAgent', () => ({ phoneAgentAvailable: () => mocks.available }))
vi.mock('../../../../apps/desktop/src/mobile/phone-device/nativePhoneActions', () => ({
  HEALTH_TYPES: ['steps', 'sleep'],
  nativePhoneActions: { deviceInfo: async () => ({ install_key: mocks.installKey }), requestPermissions: mocks.runtimeRequest, healthRequest: mocks.healthRequest, openSettings: mocks.nativeSettings },
}))
vi.mock('../../../../apps/desktop/src/mobile/phone-device/phoneDataActions', async (original) => {
  const actual = await original<typeof import('../../../../apps/desktop/src/mobile/phone-device/phoneDataActions')>()
  return { ...actual, nativePhoneData: { request: mocks.dataRequest } }
})
vi.mock('../../../../apps/desktop/src/mobile/phone-device/phoneDeviceRuntime', () => ({
  usePhoneDevice: () => ({ os: mocks.os, host: mocks.host, link: { state: 'off' } }),
  refreshPhoneDevice: mocks.refresh, stopPhoneAgentHost: vi.fn(), restartPhoneAgentHost: mocks.restartHost,
}))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: {
  kind: 'capacitor', systemPermissions: mocks.permissions,
  checkSystemPermission: mocks.check, requestSystemPermission: mocks.request, openSystemPermissionSettings: mocks.settings,
  subscribeAppForeground: (listener: () => void) => { mocks.foreground.push(listener); return () => { mocks.foreground = mocks.foreground.filter((value) => value !== listener) } },
} }))
vi.mock('../../../../apps/desktop/src/components/ui/Sheet', () => ({
  Sheet: ({ children, testId, fullScreenMobile }: { children: ReactNode; testId?: string; fullScreenMobile?: boolean }) => createElement('section', { role: 'dialog', 'data-testid': testId ?? 'phone-agent-setup', 'data-full-screen-mobile': fullScreenMobile }, children),
}))

vi.mock('../../../../apps/desktop/src/store/auth', () => ({ useAuth: () => ({ user: { id: mocks.owner } }) }))
import { PhoneDeviceActionsPage } from '../../../../apps/desktop/src/mobile/phone-device/PhoneDeviceActionsPage'
import { PhoneAgentSetupGate } from '../../../../apps/desktop/src/mobile/local-agent/PhoneAgentSetupGate'
import { PhoneInstallationContext } from '../../../../apps/desktop/src/mobile/local-agent/PhoneInstallationContext'
import { PhoneCapabilityGroups } from '../../../../apps/desktop/src/mobile/phone-device/PhoneCapabilityGroups'
import { PHONE_ACTION_GROUPS } from '../../../../apps/desktop/src/mobile/phone-device/phoneActionCatalog'
import { openPhoneAgentSetup, readPhoneAgentSetup, savePhoneAgentSetup } from '../../../../apps/desktop/src/mobile/local-agent/PhoneAgentSetupState'
import { effectiveGrants, phoneInstallId, readPhoneDeviceSettings, setPhoneActionGroup, setPhoneDeviceEnabled } from '../../../../apps/desktop/src/mobile/phone-device/phoneDeviceSettings'

function osState(): PhoneOsState {
  return {
    runtime: { calendar: 'prompt', contacts: 'prompt', location: 'prompt', coarseLocation: 'prompt' },
    special: { notification_listener: false, dnd_access: false, location_enabled: true, background_location: false, alarm_app: true, foreground: true },
    health: { supported: true, granted_types: [], background_supported: true, background_granted: false },
    data: { supported: true, sms: false, audio: false, images: false, videos: false, selected: false },
  }
}
const active: Array<ReturnType<typeof createReactHarness>> = []
const byId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
function Product() { return createElement('div', { 'data-testid': 'main-product', 'data-owner': useContext(PhoneInstallationContext) }, '主界面') }
async function renderGate(ownerId: string) {
  const harness = createReactHarness(); active.push(harness)
  await harness.render(createNode(PhoneAgentSetupGate, { ownerId, children: createElement(Product) }))
  await waitForCondition(() => !!byId('phone-agent-setup-form') || !document.querySelector('[role="dialog"]'), 'phone guide loaded')
  return harness
}
beforeEach(() => {
  mocks.permissions.splice(0, mocks.permissions.length, 'notifications', 'batteryOptimization', 'camera'); mocks.host = null
  vi.clearAllMocks(); localStorage.clear(); mocks.installKey = 'native-install-a'; mocks.available = true; mocks.os = osState(); mocks.foreground = []
  mocks.check.mockResolvedValue('prompt'); mocks.request.mockResolvedValue('blocked'); mocks.runtimeRequest.mockResolvedValue({}); mocks.refresh.mockResolvedValue(undefined)
})
afterEach(() => { for (const harness of active.splice(0)) harness.cleanup() })

describe('phone permission form', () => {
  it('shows every supported permission and all nine capability categories without an avatar or a four-step tour', async () => {
    await renderGate('all-form-fields-owner')
    expect(byId('main-product')).not.toBeNull()
    expect(document.querySelector('[role="dialog"]')?.getAttribute('data-full-screen-mobile')).toBe('true')
    expect(byId('phone-agent-setup-form')?.querySelector('img')).toBeNull()
    expect(document.querySelector('[role="progressbar"]')).toBeNull()
    for (const group of PHONE_ACTION_GROUPS) expect(byId(`phone-setup-group-${group}`)).not.toBeNull()
    for (const permission of mocks.permissions) expect(byId(`phone-setup-${permission}`)).not.toBeNull()
    expect(byId('phone-agent-setup-form')?.textContent).toContain('3 项系统权限 · 9 类手机能力')
    expect(mocks.request).not.toHaveBeenCalled(); expect(mocks.runtimeRequest).not.toHaveBeenCalled(); expect(mocks.nativeSettings).not.toHaveBeenCalled()
  })

  it('uses the reference back and next controls, reviews real choices, and returns without losing them', async () => {
    const owner = 'form-review-navigation-owner'
    mocks.check.mockImplementation(async (permission) => permission === 'notifications' ? 'granted' : permission === 'camera' ? 'unreadable' : 'prompt')
    await renderGate(owner)
    expect(document.querySelector('.gg-phone-setup-navigation')?.querySelectorAll('button').length).toBe(2)
    expect(document.querySelector('[aria-current="step"]')?.textContent).toBe('1 授权设置')
    expect(byId('phone-agent-setup-finish')).toBeNull()
    await clickElement(byId('phone-setup-connect-calendar')!)
    const requests = mocks.runtimeRequest.mock.calls.length
    await clickElement(byId('phone-agent-setup-next')!)
    expect(byId('phone-agent-setup-review')).not.toBeNull()
    expect(document.querySelector('[aria-current="step"]')?.textContent).toBe('2 确认设置')
    expect(byId('phone-agent-setup-review')?.querySelector('button')).toBeNull()
    expect(byId('phone-agent-setup-review')?.textContent).toContain('消息提醒已开启')
    expect(byId('phone-agent-setup-review')?.textContent).toContain('相机状态未知')
    expect(byId('phone-setup-group-calendar')?.textContent).toContain('已选择，尚缺系统授权')
    expect(mocks.runtimeRequest).toHaveBeenCalledTimes(requests)
    expect(mocks.request).not.toHaveBeenCalled()
    expect(readPhoneAgentSetup(owner, phoneInstallId(mocks.installKey)).completed).toBe(false)
    await clickElement(document.querySelector<HTMLElement>('[aria-label="返回授权设置"]')!)
    expect(byId('phone-agent-setup-review')).toBeNull()
    expect(readPhoneDeviceSettings(owner).groups.calendar).toBe(true)
    expect(byId('phone-setup-capability-calendar')).not.toBeNull()
    expect(byId('phone-setup-notifications')).toBeNull()
    await clickElement(byId('phone-agent-setup-next')!)
    await clickElement(byId('phone-agent-setup-finish')!)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(readPhoneAgentSetup(owner, phoneInstallId(mocks.installKey)).completed).toBe(true)
    expect(mocks.runtimeRequest).toHaveBeenCalledTimes(requests)
  })

  it('enables hosting only after the explicit host action and never grants phone data with it', async () => {
    const owner = 'form-host-opt-in-owner'
    await renderGate(owner)
    expect(readPhoneDeviceSettings(owner)).toMatchObject({ enabled: false, hostEnabled: false })
    await clickElement(byId('phone-setup-enable-host')!)
    expect(readPhoneDeviceSettings(owner)).toMatchObject({ enabled: false, hostEnabled: true })
    expect(Object.values(effectiveGrants(readPhoneDeviceSettings(owner))).every((grant) => !grant)).toBe(true)
    expect(mocks.request).not.toHaveBeenCalled()
  })

  it('completion does not enable unchecked choices or request any permissions', async () => {
    const owner = 'form-optional-owner'
    await renderGate(owner)
    await clickElement(byId('phone-agent-setup-next')!)
    await clickElement(byId('phone-agent-setup-finish')!)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(readPhoneAgentSetup(owner, phoneInstallId(mocks.installKey)).completed).toBe(true)
    expect(readPhoneDeviceSettings(owner)).toMatchObject({ enabled: false, hostEnabled: false })
    expect(mocks.request).not.toHaveBeenCalled(); expect(mocks.runtimeRequest).not.toHaveBeenCalled(); expect(mocks.settings).not.toHaveBeenCalled()
  })

  it('remembers dismissal on this installation and shows a new phone the ungranted form', async () => {
    const owner = 'form-skip-install-owner'
    const first = await renderGate(owner)
    await clickElement(document.querySelector<HTMLElement>('[aria-label="返回咕咕"]')!)
    first.cleanup(); active.splice(active.indexOf(first), 1)
    const same = await renderGate(owner)
    await waitForCondition(() => byId('main-product')?.dataset.owner === owner, 'installation loaded')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    same.cleanup(); active.splice(active.indexOf(same), 1)
    mocks.installKey = 'new-form-native-install'
    await renderGate(owner)
    expect(byId('phone-agent-setup-form')).not.toBeNull()
    expect(readPhoneDeviceSettings(owner).hostEnabled).toBe(false)
  })

  it('opens the complete form for legacy saved steps without inheriting another account progress', async () => {
    const installId = phoneInstallId(mocks.installKey)
    savePhoneAgentSetup('legacy-form-owner', installId, { step: 'tools', dismissed: true, completed: false })
    expect(readPhoneAgentSetup('separate-form-owner', installId).dismissed).toBe(false)
    await renderGate('legacy-form-owner')
    await act(async () => { openPhoneAgentSetup('legacy-form-owner') })
    expect(byId('phone-setup-enable-host')).not.toBeNull()
    for (const group of PHONE_ACTION_GROUPS) expect(byId(`phone-setup-group-${group}`)).not.toBeNull()
    expect(mocks.runtimeRequest).not.toHaveBeenCalled()
  })

  it('reopens on the first request after switching accounts with different request counts', async () => {
    const installId = phoneInstallId(mocks.installKey)
    const previous = 'previous-form-owner', current = 'current-form-owner'
    for (const owner of [previous, current]) savePhoneAgentSetup(owner, installId, { step: 'tools', dismissed: true, completed: true })
    const harness = await renderGate(previous)
    await waitForCondition(() => byId('main-product')?.dataset.owner === previous, 'previous binding ready')
    await act(async () => { openPhoneAgentSetup(previous); openPhoneAgentSetup(previous) })
    await clickElement(document.querySelector<HTMLElement>('[aria-label="返回咕咕"]')!)
    await harness.render(createNode(PhoneAgentSetupGate, { ownerId: current, children: createElement(Product) }))
    await waitForCondition(() => byId('main-product')?.dataset.owner === current, 'current binding ready')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    await act(async () => { openPhoneAgentSetup(current) })
    expect(byId('phone-agent-setup-form')).not.toBeNull()
  })

  it('keeps the normal system permission actions usable when status reading fails', async () => {
    mocks.check.mockRejectedValue(new Error('native check unavailable'))
    await renderGate('form-unknown-system-owner')
    expect(byId('phone-setup-notifications')?.textContent).toBe('开启消息通知')
    expect(document.querySelector('[role="alert"]')).toBeNull()
    await clickElement(byId('phone-setup-notifications')!)
    await clickElement(byId('phone-setup-batteryOptimization')!)
    expect(mocks.settings).toHaveBeenCalledWith('notifications')
    expect(mocks.settings).toHaveBeenCalledWith('batteryOptimization')
    expect(document.querySelector('[role="alert"]')).toBeNull()
  })

  it('shows known enabled permissions as enabled, without another request button', async () => {
    mocks.check.mockResolvedValue('granted')
    await renderGate('form-enabled-system-owner')
    await waitForCondition(() => !byId('phone-setup-notifications'), 'granted state loaded')
    expect(document.querySelectorAll('.gg-phone-setup-field[data-state="granted"]').length).toBe(3)
    expect(mocks.request).not.toHaveBeenCalled(); expect(mocks.settings).not.toHaveBeenCalled()
  })

  it('requests camera only from its own row and leaves hosting and phone data off', async () => {
    const owner = 'form-camera-owner'
    await renderGate(owner)
    await clickElement(byId('phone-setup-camera')!)
    expect(mocks.request).toHaveBeenCalledExactlyOnceWith('camera')
    expect(readPhoneDeviceSettings(owner)).toMatchObject({ enabled: false, hostEnabled: false })
    expect(mocks.runtimeRequest).not.toHaveBeenCalled()
  })

  it('keeps a denied notification optional and gives the manual settings route on failure', async () => {
    await renderGate('form-denied-notification-owner')
    mocks.check.mockResolvedValue('blocked')
    await clickElement(byId('phone-setup-notifications')!)
    expect(byId('phone-setup-notifications')?.textContent).toBe('前往通知设置')
    mocks.settings.mockResolvedValueOnce(false)
    await clickElement(byId('phone-setup-notifications')!)
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('系统的应用设置里找到咕咕')
    expect(document.querySelector('[role="alert"]')?.textContent).not.toContain('稍后重试')
    expect(byId('phone-agent-setup-next')?.hasAttribute('disabled')).toBe(false)
  })

  it('connects only the explicit capability and does not restore disabled choices', async () => {
    const owner = 'form-specific-category-owner'
    setPhoneActionGroup(owner, 'contacts', true); setPhoneDeviceEnabled(owner, false)
    await renderGate(owner)
    await clickElement(byId('phone-setup-connect-calendar')!)
    expect(mocks.runtimeRequest).toHaveBeenCalledExactlyOnceWith({ permissions: ['calendar'] })
    expect(readPhoneDeviceSettings(owner)).toMatchObject({ enabled: true, hostEnabled: false, groups: { calendar: true, contacts: false } })
    expect(byId('phone-setup-group-calendar')?.textContent).toContain('尚缺系统授权')
    expect(document.querySelectorAll('[role="dialog"]').length).toBe(1)
    expect(byId('phone-setup-capability-calendar')).not.toBeNull()
  })

  it('does not grant capabilities when native state is unreadable and still allows completion', async () => {
    mocks.refresh.mockRejectedValue(new Error('native permission check failed'))
    await renderGate('form-unreadable-capability-owner')
    await waitForCondition(() => byId('phone-setup-connect-calendar')?.hasAttribute('disabled') === true, 'safe disabled connection')
    expect(mocks.runtimeRequest).not.toHaveBeenCalled()
    await clickElement(byId('phone-agent-setup-next')!)
    await clickElement(byId('phone-agent-setup-finish')!)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('expands notification details in the form and keeps notification-reading, DND and message alerts separate', async () => {
    mocks.os!.special.dnd_access = true
    await renderGate('form-notification-details-owner')
    await clickElement(byId('phone-setup-group-notifications')!.querySelector<HTMLElement>('[aria-expanded]')!)
    const details = byId('phone-setup-capability-notifications')!
    expect(details.textContent).toContain('通知读取 · 未授权')
    expect(details.textContent).toContain('勿扰控制 · 已授权')
    expect(document.querySelectorAll('[role="dialog"]').length).toBe(1)
    expect(mocks.nativeSettings).not.toHaveBeenCalled()
    expect(mocks.request).not.toHaveBeenCalled()
  })

  it('keeps special permission grants individually actionable after choosing a category', async () => {
    await renderGate('form-notification-grants-owner')
    await clickElement(byId('phone-setup-connect-notifications')!)
    expect(mocks.nativeSettings).toHaveBeenCalledExactlyOnceWith({ target: 'notification_listener' })
    expect(byId('phone-setup-grant-dnd_access')).not.toBeNull()
    await clickElement(byId('phone-setup-grant-dnd_access')!)
    expect(mocks.nativeSettings).toHaveBeenLastCalledWith({ target: 'dnd' })
    expect(mocks.request).not.toHaveBeenCalled()
  })

  it('keeps host failure and recovery inline', async () => {
    const owner = 'form-host-failure-owner'
    mocks.host = { ownerId: owner, ready: false, status: 'failed', error: 'host could not start', sessions: [] }
    mocks.restartHost.mockRejectedValueOnce(new Error('retry failed'))
    await renderGate(owner)
    await clickElement(byId('phone-setup-enable-host')!)
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('host could not start')
    await clickElement(byId('phone-setup-enable-host')!)
    expect(mocks.restartHost).toHaveBeenCalledWith(owner)
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('retry failed')
    expect(byId('phone-agent-setup-form')).not.toBeNull()
  })

  it('keeps a failed completion visible so it can be saved again', async () => {
    const owner = 'form-save-failure-owner'
    await renderGate(owner)
    const setItem = localStorage.setItem
    const saved = vi.spyOn(localStorage, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key.startsWith('gugu.phoneAgentSetup.v1:')) throw new Error('storage unavailable')
      setItem.call(this, key, value)
    })
    await clickElement(byId('phone-agent-setup-next')!)
    await clickElement(byId('phone-agent-setup-finish')!)
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('storage unavailable')
    expect(readPhoneAgentSetup(owner, phoneInstallId(mocks.installKey)).completed).toBe(false)
    saved.mockRestore()
    await clickElement(byId('phone-agent-setup-finish')!)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('only lists system permissions supported by the current host', async () => {
    mocks.permissions.splice(0, mocks.permissions.length, 'notifications')
    await renderGate('form-one-system-permission-owner')
    expect(byId('phone-setup-notifications')).not.toBeNull()
    expect(byId('phone-setup-camera')).toBeNull()
    expect(byId('phone-setup-batteryOptimization')).toBeNull()
    expect(byId('phone-agent-setup-form')?.textContent).toContain('1 项系统权限 · 9 类手机能力')
  })

  it('refreshes both OS states on return without requesting permissions', async () => {
    await renderGate('form-foreground-owner')
    const before = mocks.refresh.mock.calls.length
    await act(async () => { for (const listener of mocks.foreground) listener() })
    expect(mocks.refresh.mock.calls.length).toBeGreaterThan(before)
    expect(mocks.request).not.toHaveBeenCalled(); expect(mocks.runtimeRequest).not.toHaveBeenCalled()
  })

  it('retains the existing details sheet presentation in device settings', async () => {
    const harness = createReactHarness(); active.push(harness)
    await harness.render(createNode(PhoneCapabilityGroups, { ownerId: 'form-existing-settings-owner' }))
    await clickElement(byId('phone-device-group-calendar')!.querySelector<HTMLElement>('[role="button"]')!)
    expect(byId('phone-device-capability-calendar')).not.toBeNull()
    expect(mocks.runtimeRequest).not.toHaveBeenCalled()
  })
})

describe('phone task permissions without a remote-device master', () => {
  it('shows all categories without enabling the host or granting data on mount', async () => {
    const owner = 'settings-without-master'
    mocks.owner = owner
    const harness = createReactHarness(); active.push(harness)
    await harness.render(createNode(PhoneDeviceActionsPage))
    expect(byId('phone-device-master')).toBeNull()
    expect(harness.container.textContent).not.toMatch(/让助理用这台手机|正在连接|已连接，可以/)
    for (const group of PHONE_ACTION_GROUPS) expect(byId(`phone-device-group-${group}`)).not.toBeNull()
    for (const permission of mocks.permissions) expect(byId(`phone-device-system-${permission}`)).not.toBeNull()
    expect(harness.container.querySelector('[role="dialog"]')).toBeNull()
    expect(harness.container.textContent).not.toContain('权限设置')
    expect(readPhoneDeviceSettings(owner)).toMatchObject({ enabled: false, hostEnabled: false })
    expect(Object.values(effectiveGrants(readPhoneDeviceSettings(owner))).every(value => !value)).toBe(true)
    expect(mocks.request).not.toHaveBeenCalled(); expect(mocks.runtimeRequest).not.toHaveBeenCalled()
  })

  it('authorizes only an explicitly chosen category from normal settings', async () => {
    const owner = 'settings-one-category'
    mocks.owner = owner
    setPhoneActionGroup(owner, 'contacts', true); setPhoneDeviceEnabled(owner, false)
    const harness = createReactHarness(); active.push(harness)
    await harness.render(createNode(PhoneDeviceActionsPage))
    await clickElement(byId('phone-device-group-calendar')!)
    expect(readPhoneDeviceSettings(owner)).toMatchObject({ enabled: true, hostEnabled: false, groups: { calendar: true, contacts: false } })
    expect(mocks.runtimeRequest).toHaveBeenCalledExactlyOnceWith({ permissions: ['calendar'] })
    expect(document.querySelectorAll('[role="alert"]')).toHaveLength(0)
  })

  it('requests data and special permissions directly from their rows and refreshes after foreground', async () => {
    const owner = 'settings-direct-permissions'; mocks.owner = owner
    mocks.dataRequest.mockResolvedValue({ supported: true, images: true, videos: true })
    const harness = createReactHarness(); active.push(harness)
    await harness.render(createNode(PhoneDeviceActionsPage))
    await clickElement(byId('phone-device-group-photos')!)
    expect(mocks.dataRequest).toHaveBeenCalledExactlyOnceWith({ group: 'photos' })
    await clickElement(byId('phone-device-group-notifications')!)
    expect(mocks.nativeSettings).toHaveBeenLastCalledWith({ target: 'notification_listener' })
    mocks.os = { ...osState(), special: { ...osState().special, notification_listener: true } }
    const before = mocks.refresh.mock.calls.length
    await act(async () => { for (const listener of mocks.foreground) listener() })
    await waitForCondition(() => byId('phone-device-group-notifications')?.textContent?.includes('1/2') === true, 'fresh special permission state')
    expect(mocks.refresh.mock.calls.length).toBeGreaterThan(before)
    await clickElement(byId('phone-device-group-notifications')!)
    expect(mocks.nativeSettings).toHaveBeenLastCalledWith({ target: 'dnd' })
    await clickElement(byId('phone-device-system-camera')!)
    expect(mocks.request).toHaveBeenCalledExactlyOnceWith('camera')
    expect(readPhoneDeviceSettings(owner).hostEnabled).toBe(false)
  })
})
