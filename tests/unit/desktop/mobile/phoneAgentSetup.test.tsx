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
  check: vi.fn(async () => 'prompt'), request: vi.fn(async () => 'blocked'), settings: vi.fn(async () => true),
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
  Sheet: ({ children, testId }: { children: ReactNode; testId?: string }) => createElement('section', { role: 'dialog', 'data-testid': testId ?? 'phone-agent-setup' }, children),
}))

import { PhoneAgentSetupGate } from '../../../../apps/desktop/src/mobile/local-agent/PhoneAgentSetupGate'
import { PhoneInstallationContext } from '../../../../apps/desktop/src/mobile/local-agent/PhoneInstallationContext'
import { PhoneAgentSetupTools } from '../../../../apps/desktop/src/mobile/local-agent/PhoneAgentSetupPermissions'
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
  await waitForCondition(() => !!byId('phone-agent-setup-host') || !document.querySelector('[role="dialog"]'), 'phone guide loaded')
  return harness
}
beforeEach(() => {
  mocks.permissions.splice(0, mocks.permissions.length, 'notifications', 'batteryOptimization', 'camera'); mocks.host = null
  vi.clearAllMocks(); localStorage.clear(); mocks.installKey = 'native-install-a'; mocks.available = true; mocks.os = osState(); mocks.foreground = []
  mocks.check.mockResolvedValue('prompt'); mocks.request.mockResolvedValue('blocked'); mocks.runtimeRequest.mockResolvedValue({}); mocks.refresh.mockResolvedValue(undefined)
})
afterEach(() => { for (const harness of active.splice(0)) harness.cleanup() })

describe('phone installation guide', () => {
  it('reopens once after switching accounts even when the previous account requested the guide more often', async () => {
    const installId = phoneInstallId(mocks.installKey)
    const previous = 'reopen-previous-owner', current = 'reopen-current-owner'
    for (const owner of [previous, current]) savePhoneAgentSetup(owner, installId, { step: 'tools', dismissed: true, completed: true })
    const harness = await renderGate(previous)
    await waitForCondition(() => byId('main-product')?.dataset.owner === previous, 'previous install binding ready')
    await act(async () => { openPhoneAgentSetup(previous); openPhoneAgentSetup(previous) })
    await waitForCondition(() => !!byId('phone-agent-setup-host'), 'previous guide opened')
    await clickElement(document.querySelector<HTMLElement>('[aria-label="关闭面板"]')!)
    await harness.render(createNode(PhoneAgentSetupGate, { ownerId: current, children: createElement(Product) }))
    await waitForCondition(() => byId('main-product')?.dataset.owner === current, 'current install binding ready')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    await act(async () => { openPhoneAgentSetup(current) })
    await waitForCondition(() => !!byId('phone-agent-setup-host'), 'current guide opens on first request')
    expect(mocks.request).not.toHaveBeenCalled()
  })

  it('keeps a failed completion visible with its error so it can be saved again', async () => {
    const owner = 'completion-save-failure-owner'
    await renderGate(owner)
    await waitForCondition(() => !!byId('phone-agent-setup-next'), 'guide loaded')
    await clickElement(byId('phone-agent-setup-next')!); await clickElement(byId('phone-agent-setup-next')!); await clickElement(byId('phone-agent-setup-next')!)
    const setItem = localStorage.setItem
    const saved = vi.spyOn(localStorage, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key.startsWith('gugu.phoneAgentSetup.v1:')) throw new Error('storage unavailable')
      setItem.call(this, key, value)
    })
    await clickElement(byId('phone-agent-setup-next')!)
    expect(saved).toHaveBeenCalled()
    expect(byId('phone-agent-setup-tools')).not.toBeNull()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('storage unavailable')
    expect(readPhoneAgentSetup(owner, phoneInstallId(mocks.installKey)).completed).toBe(false)
    saved.mockRestore()
    await clickElement(byId('phone-agent-setup-next')!)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(readPhoneAgentSetup(owner, phoneInstallId(mocks.installKey)).completed).toBe(true)
  })

  it('keeps the real app mounted and requests nothing before an explicit user action', async () => {
    await renderGate('fresh-install-owner')
    await waitForCondition(() => !!byId('phone-agent-setup-host'), 'host step')
    expect(byId('main-product')).not.toBeNull()
    expect(byId('phone-agent-setup-host')?.textContent).toContain('手机 Agent')
    expect(byId('phone-agent-setup-host')?.textContent).not.toMatch(/\bpi\b|harness/i)
    expect(readPhoneDeviceSettings('fresh-install-owner')).toMatchObject({ enabled: false, hostEnabled: false })
    expect(mocks.request).not.toHaveBeenCalled(); expect(mocks.runtimeRequest).not.toHaveBeenCalled(); expect(mocks.nativeSettings).not.toHaveBeenCalled()
    await clickElement([...document.querySelectorAll('button')].find((button) => button.textContent === '启用手机 Agent')!)
    expect(readPhoneDeviceSettings('fresh-install-owner')).toMatchObject({ enabled: false, hostEnabled: true })
    expect(Object.values(effectiveGrants(readPhoneDeviceSettings('fresh-install-owner'))).every((grant) => !grant)).toBe(true)
  })

  it('a declined recommendation does not block completion or grant phone data', async () => {
    const owner = 'declined-recommendation-owner'
    await renderGate(owner)
    await waitForCondition(() => !!byId('phone-agent-setup-next'), 'guide ready')
    await clickElement(byId('phone-agent-setup-next')!)
    await waitForCondition(() => !!byId('phone-setup-notifications') && !byId('phone-setup-notifications')!.hasAttribute('disabled'), 'system state loaded')
    expect(mocks.request).not.toHaveBeenCalled()
    await clickElement(byId('phone-setup-notifications')!)
    expect(mocks.request).toHaveBeenCalledWith('notifications')
    await clickElement(byId('phone-agent-setup-next')!)
    expect(byId('phone-agent-setup-background')).not.toBeNull()
    await clickElement(byId('phone-agent-setup-next')!)
    expect(byId('phone-agent-setup-tools')).not.toBeNull()
    expect(mocks.runtimeRequest).not.toHaveBeenCalled()
    await clickElement(byId('phone-agent-setup-next')!)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(readPhoneDeviceSettings(owner)).toMatchObject({ enabled: false, hostEnabled: false })
    expect(readPhoneAgentSetup(owner, phoneInstallId(mocks.installKey))).toMatchObject({ completed: true })
  })

  it('remembers a skip for this account and install, but a restored different phone sees the guide', async () => {
    const owner = 'skip-per-install-owner'
    const first = await renderGate(owner)
    await waitForCondition(() => !!document.querySelector('[aria-label="关闭面板"]'), 'guide ready')
    await clickElement(document.querySelector<HTMLElement>('[aria-label="关闭面板"]')!)
    first.cleanup(); active.splice(active.indexOf(first), 1)
    const same = await renderGate(owner)
    await waitForCondition(() => !!localStorage.getItem('gugu.phoneDevice.install'), 'install read')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    same.cleanup(); active.splice(active.indexOf(same), 1)
    mocks.installKey = 'native-different-phone'
    await renderGate(owner)
    await waitForCondition(() => !!byId('phone-agent-setup-host'), 'new phone guide')
    expect(readPhoneDeviceSettings(owner).hostEnabled).toBe(false)
  })

  it('isolates account progress and reopens the saved step from device settings', async () => {
    const installId = phoneInstallId(mocks.installKey)
    savePhoneAgentSetup('resume-owner', installId, { step: 'tools', dismissed: true, completed: false })
    expect(readPhoneAgentSetup('another-account', installId)).toMatchObject({ step: 'host', dismissed: false })
    await renderGate('resume-owner')
    await act(async () => { openPhoneAgentSetup('resume-owner') })
    await waitForCondition(() => !!byId('phone-agent-setup-tools'), 'guide reopened')
    expect(mocks.runtimeRequest).not.toHaveBeenCalled()
  })

  it('shows the guide for another account on the same phone without using the previous account progress', async () => {
    const installId = phoneInstallId(mocks.installKey)
    savePhoneAgentSetup('finished-previous-account', installId, { step: 'tools', dismissed: true, completed: true })
    await renderGate('new-account-on-same-phone')
    await waitForCondition(() => !!byId('phone-agent-setup-host'), 'new account guide')
    expect(readPhoneDeviceSettings('new-account-on-same-phone')).toMatchObject({ enabled: false, hostEnabled: false })
    expect(mocks.request).not.toHaveBeenCalled()
  })

  it('reports corrupt presentation progress and lets the user deliberately save a fresh choice', async () => {
    const owner = 'corrupt-progress-owner', installId = phoneInstallId(mocks.installKey)
    savePhoneAgentSetup(owner, installId, { step: 'tools', dismissed: true, completed: true })
    const key = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)!).find((value) => value.includes(owner))!
    localStorage.setItem(key, '{broken')
    await renderGate(owner)
    await waitForCondition(() => !!byId('phone-agent-setup-host'), 'corrupt record shown honestly')
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('JSON')
    expect(readPhoneDeviceSettings(owner)).toMatchObject({ enabled: false, hostEnabled: false })
    await clickElement(document.querySelector<HTMLElement>('[aria-label="关闭面板"]')!)
    expect(readPhoneAgentSetup(owner, installId).dismissed).toBe(true)
  })

  it('only connects the category the user selected, without silently restoring other disabled grants', async () => {
    const owner = 'specific-category-owner'
    setPhoneActionGroup(owner, 'contacts', true)
    setPhoneDeviceEnabled(owner, false)
    const harness = createReactHarness(); active.push(harness)
    await harness.render(createNode(PhoneAgentSetupTools, { ownerId: owner }))
    expect(mocks.runtimeRequest).not.toHaveBeenCalled()
    await clickElement(byId('phone-setup-choose-capabilities')!)
    await clickElement(byId('phone-setup-group-calendar')!.querySelector<HTMLElement>('[role="button"]')!)
    await clickElement(byId('phone-setup-connect-calendar')!)
    expect(mocks.runtimeRequest).toHaveBeenCalledWith({ permissions: ['calendar'] })
    expect(readPhoneDeviceSettings(owner)).toMatchObject({ enabled: true, hostEnabled: false, groups: { calendar: true, contacts: false } })
    expect(document.querySelector('[data-testid="phone-setup-group-calendar"]')?.textContent).toContain('尚缺系统授权')
    expect(mocks.refresh).toHaveBeenCalled()
    expect(mocks.foreground.length).toBeGreaterThan(0)
    await act(async () => { for (const listener of mocks.foreground) listener() })
    await waitForCondition(() => mocks.refresh.mock.calls.length >= 3, 'permission refreshed on resume')
  })

  it('cannot grant a category when reading the system state failed, but retains the continue path', async () => {
    mocks.refresh.mockRejectedValue(new Error('native permission check failed'))
    await renderGate('unreadable-permission-owner')
    await waitForCondition(() => !!byId('phone-agent-setup-next'), 'guide ready')
    await clickElement(byId('phone-agent-setup-next')!); await clickElement(byId('phone-agent-setup-next')!); await clickElement(byId('phone-agent-setup-next')!)
    await clickElement(byId('phone-setup-choose-capabilities')!)
    await clickElement(byId('phone-setup-group-calendar')!.querySelector<HTMLElement>('[role="button"]')!)
    await waitForCondition(() => byId('phone-setup-connect-calendar')?.hasAttribute('disabled') === true, 'unsafe action disabled')
    expect(byId('phone-agent-setup-next')?.hasAttribute('disabled')).toBe(false)
    expect(mocks.runtimeRequest).not.toHaveBeenCalled()
  })

  it('opens capability details without granting anything and distinguishes notification scopes', async () => {
    mocks.os!.special.dnd_access = true
    const harness = createReactHarness(); active.push(harness)
    await harness.render(createNode(PhoneAgentSetupTools, { ownerId: 'permission-sheet-owner' }))
    expect(byId('phone-setup-connect-notifications')).toBeNull()
    await clickElement(byId('phone-setup-choose-capabilities')!)
    await clickElement(byId('phone-setup-group-notifications')!.querySelector<HTMLElement>('[role="button"]')!)
    const sheet = byId('phone-setup-capability-notifications')!
    expect(sheet.textContent).toContain('通知读取 · 未授权')
    expect(sheet.textContent).toContain('勿扰控制 · 已授权')
    expect(sheet.textContent).toContain('咕咕自己的消息提醒')
    expect(mocks.runtimeRequest).not.toHaveBeenCalled()
    expect(mocks.nativeSettings).not.toHaveBeenCalled()
    expect(readPhoneDeviceSettings('permission-sheet-owner')).toMatchObject({ enabled: false, groups: { notifications: false } })
  })
})

describe('minimal phone setup actions', () => {
  it('keeps host failures inline and retries without advancing the guide', async () => {
    const owner = 'host-failure-owner'
    mocks.host = { ownerId: owner, ready: false, status: 'failed', error: 'host could not start', sessions: [] }
    mocks.restartHost.mockRejectedValueOnce(new Error('retry failed'))
    await renderGate(owner)
    await clickElement(byId('phone-setup-enable-host')!)
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('host could not start')
    expect(byId('phone-setup-enable-host')?.textContent).toBe('重新连接手机 Agent')
    await clickElement(byId('phone-setup-enable-host')!)
    expect(mocks.restartHost).toHaveBeenCalledWith(owner)
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('retry failed')
    expect(byId('phone-agent-setup-host')).not.toBeNull()
  })

  it('skips unsupported system settings and names the real next action', async () => {
    mocks.permissions.splice(0, mocks.permissions.length, 'notifications')
    await renderGate('notifications-only-owner')
    await clickElement(byId('phone-agent-setup-next')!)
    await waitForCondition(() => byId('phone-setup-notifications')?.hasAttribute('disabled') === false, 'notification state')
    mocks.request.mockResolvedValueOnce('granted')
    mocks.check.mockResolvedValue('granted')
    await clickElement(byId('phone-setup-notifications')!)
    expect(byId('phone-setup-notifications')?.textContent).toBe('选择手机能力')
    await clickElement(byId('phone-setup-notifications')!)
    expect(byId('phone-agent-setup-tools')).not.toBeNull()
    expect(byId('phone-agent-setup-background')).toBeNull()
  })

  it('can skip every step without enabling hosting, tools, or system permissions', async () => {
    const owner = 'skip-every-step-owner'
    await renderGate(owner)
    for (let step = 0; step < 4; step++) await clickElement(byId('phone-agent-setup-next')!)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(readPhoneDeviceSettings(owner)).toMatchObject({ enabled: false, hostEnabled: false })
    expect(mocks.request).not.toHaveBeenCalled()
    expect(mocks.runtimeRequest).not.toHaveBeenCalled()
    expect(mocks.settings).not.toHaveBeenCalled()
  })

  it('keeps a denied notification request optional and opens settings on the next explicit action', async () => {
    await renderGate('notification-denial-owner')
    await clickElement(byId('phone-agent-setup-next')!)
    await waitForCondition(() => byId('phone-setup-notifications')?.hasAttribute('disabled') === false, 'notification state')
    mocks.check.mockResolvedValue('blocked')
    await clickElement(byId('phone-setup-notifications')!)
    expect(byId('phone-setup-notifications')?.textContent).toBe('前往通知设置')
    expect(mocks.settings).not.toHaveBeenCalled()
    mocks.settings.mockResolvedValueOnce(false)
    await clickElement(byId('phone-setup-notifications')!)
    expect(mocks.settings).toHaveBeenCalledWith('notifications')
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('没能打开系统设置')
    await clickElement(byId('phone-agent-setup-next')!)
    expect(byId('phone-agent-setup-background')).not.toBeNull()
  })

  it('uses the refreshed system grant before showing the next action', async () => {
    await renderGate('notification-granted-owner')
    await clickElement(byId('phone-agent-setup-next')!)
    await waitForCondition(() => byId('phone-setup-notifications')?.hasAttribute('disabled') === false, 'notification state')
    mocks.request.mockResolvedValueOnce('granted')
    mocks.check.mockResolvedValue('granted')
    await clickElement(byId('phone-setup-notifications')!)
    expect(byId('phone-setup-notifications')?.textContent).toBe('设置后台运行')
    await clickElement(byId('phone-setup-notifications')!)
    expect(byId('phone-agent-setup-background')).not.toBeNull()
    expect(mocks.request).toHaveBeenCalledTimes(1)
  })
})
