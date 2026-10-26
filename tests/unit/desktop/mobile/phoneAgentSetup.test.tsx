// @vitest-environment jsdom
import { act, createElement, useContext, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clickElement, createNode, createReactHarness, waitForCondition } from '../../../support/testHarness'
import type { PhoneAgentHostState } from '../../../../apps/desktop/src/mobile/local-agent/nativeAgent'
import type { PhoneOsState } from '../../../../apps/desktop/src/mobile/phone-device/phoneActionCatalog'

const mocks = vi.hoisted(() => ({
  kind: 'capacitor', permissions: ['notifications', 'batteryOptimization', 'camera'], host: null as PhoneAgentHostState | null,
  owner: 'setup-owner', installKey: 'native-install-a', available: true, restartHost: vi.fn(),
  runtimeRequest: vi.fn(), dataRequest: vi.fn(), healthRequest: vi.fn(), nativeSettings: vi.fn(),
  check: vi.fn(), request: vi.fn(), settings: vi.fn(), foreground: [] as Array<() => void>, os: null as PhoneOsState | null, refresh: vi.fn(),
}))
vi.mock('../../../../apps/desktop/src/lib/myAssistant', () => ({ useMyAssistant: () => ({ agentId: null, provisionDeviceId: null, loading: false, error: null }) }))
vi.mock('../../../../apps/desktop/src/mobile/local-agent/nativeAgent', () => ({ phoneAgentAvailable: () => mocks.available }))
vi.mock('../../../../apps/desktop/src/mobile/phone-device/nativePhoneActions', () => ({
  HEALTH_TYPES: ['steps', 'sleep'], nativePhoneActions: { deviceInfo: async () => ({ install_key: mocks.installKey, registration_id: `registration-${mocks.installKey}` }), requestPermissions: mocks.runtimeRequest, healthRequest: mocks.healthRequest, openSettings: mocks.nativeSettings },
}))
vi.mock('../../../../apps/desktop/src/mobile/phone-device/phoneDataActions', async original => ({
  ...await original<typeof import('../../../../apps/desktop/src/mobile/phone-device/phoneDataActions')>(), nativePhoneData: { request: mocks.dataRequest },
}))
vi.mock('../../../../apps/desktop/src/mobile/phone-device/phoneDeviceRuntime', () => ({
  usePhoneDevice: () => ({ os: mocks.os, host: mocks.host, link: { state: 'off' } }), readPhoneOsState: async () => mocks.os,
  refreshPhoneDevice: mocks.refresh, stopPhoneAgentHost: vi.fn(), restartPhoneAgentHost: mocks.restartHost,
}))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: {
  get kind() { return mocks.kind }, systemPermissions: mocks.permissions,
  checkSystemPermission: mocks.check, requestSystemPermission: mocks.request, openSystemPermissionSettings: mocks.settings,
  subscribeAppForeground: (listener: () => void) => { mocks.foreground.push(listener); return () => { mocks.foreground = mocks.foreground.filter(value => value !== listener) } },
} }))
vi.mock('../../../../apps/desktop/src/components/ui/Sheet', () => ({ Sheet: ({ children, testId }: { children: ReactNode; testId?: string }) => createElement('section', { role: 'dialog', 'data-testid': testId }, children) }))
vi.mock('../../../../apps/desktop/src/store/auth', () => ({ useAuth: () => ({ user: { id: mocks.owner } }) }))
import { PhoneDeviceActionsPage } from '../../../../apps/desktop/src/mobile/phone-device/PhoneDeviceActionsPage'
import { PhoneAgentSetupGate } from '../../../../apps/desktop/src/mobile/local-agent/PhoneAgentSetupGate'
import { PhoneInstallationContext } from '../../../../apps/desktop/src/mobile/local-agent/PhoneInstallationContext'
import { PHONE_PERMISSION_ROWS } from '../../../../apps/desktop/src/mobile/phone-device/phonePermissionRows'
import { openPhoneAgentSetup, readPhoneAgentSetup, savePhoneAgentSetup } from '../../../../apps/desktop/src/mobile/local-agent/PhoneAgentSetupState'
import { phoneInstallId, readPhoneDeviceSettings, setPhoneActionGroup, setPhoneDeviceEnabled } from '../../../../apps/desktop/src/mobile/phone-device/phoneDeviceSettings'
import { PermissionsSection } from '../../../../apps/desktop/src/components/settings/PermissionsSection'
import { UI_EVENTS } from '../../../../apps/desktop/src/lib/uiEvents'

function osState(): PhoneOsState {
  return { runtime: { calendar: 'prompt', contacts: 'prompt', location: 'prompt', coarseLocation: 'prompt' }, special: { notification_listener: false, dnd_access: false, location_enabled: true, background_location: false, alarm_app: true, foreground: true }, health: { supported: true, granted_types: [], background_supported: true, background_granted: false }, data: { supported: true, sms: false, audio: false, images: false, videos: false, selected: false } }
}
const active: Array<ReturnType<typeof createReactHarness>> = []
let ownerSequence = 0
const byId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
function Product() { return createElement('div', { 'data-testid': 'main-product', 'data-owner': useContext(PhoneInstallationContext) }, '主界面') }
async function render(component = PermissionsSection) { const h = createReactHarness(); active.push(h); await h.render(createNode(component)); return h }
async function renderGate(ownerId = mocks.owner) {
  const h = createReactHarness(); active.push(h)
  await h.render(createNode(PhoneAgentSetupGate, { ownerId, children: createElement(Product) }))
  await waitForCondition(() => !!byId('phone-agent-setup-form') || !document.querySelector('[role="dialog"]'), 'installation loaded')
  return h
}
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); mocks.kind = 'capacitor'; mocks.permissions.splice(0, mocks.permissions.length, 'notifications', 'batteryOptimization', 'camera')
  mocks.host = null; mocks.owner = `setup-owner-${++ownerSequence}`; mocks.installKey = 'native-install-a'; mocks.available = true; mocks.os = osState(); mocks.foreground = []
  mocks.check.mockReset().mockResolvedValue('prompt'); mocks.request.mockReset().mockResolvedValue('blocked'); mocks.settings.mockReset().mockResolvedValue(true)
  mocks.runtimeRequest.mockReset().mockResolvedValue({}); mocks.nativeSettings.mockReset().mockResolvedValue(undefined); mocks.dataRequest.mockReset().mockResolvedValue({}); mocks.refresh.mockReset().mockResolvedValue(undefined)
})
afterEach(() => { for (const h of active.splice(0)) h.cleanup() })

describe('single phone permissions destination', () => {
  it('offers one permission link on installation, with no duplicate permission rows or automatic requests', async () => {
    await renderGate()
    expect(byId('phone-setup-open-permissions')).not.toBeNull()
    expect(byId('phone-permissions-list')).toBeNull()
    expect(document.querySelectorAll('[data-testid^="phone-setup-group-"]')).toHaveLength(0)
    await clickElement(byId('phone-agent-setup-finish')!)
    expect(readPhoneAgentSetup(mocks.owner, phoneInstallId(mocks.installKey, `registration-${mocks.installKey}`)).completed).toBe(true)
    expect(readPhoneDeviceSettings(mocks.owner)).toMatchObject({ enabled: false, hostEnabled: false })
    expect(mocks.request).not.toHaveBeenCalled(); expect(mocks.runtimeRequest).not.toHaveBeenCalled()
  })
  it('routes installation and device links to My permissions without granting anything', async () => {
    const opened: unknown[] = []; const listener = (e: Event) => opened.push((e as CustomEvent).detail)
    window.addEventListener(UI_EVENTS.openSettings, listener)
    try {
      const h = await renderGate(); await clickElement(byId('phone-setup-open-permissions')!)
      expect(document.querySelector('[role="dialog"]')).toBeNull(); h.cleanup()
      await render(PhoneDeviceActionsPage)
      expect(byId('phone-permissions-list')).toBeNull()
      await clickElement(byId('phone-device-open-permissions')!)
      expect(opened).toEqual([{ section: 'permissions' }, { section: 'permissions' }])
      expect(mocks.request).not.toHaveBeenCalled(); expect(mocks.runtimeRequest).not.toHaveBeenCalled()
    } finally { window.removeEventListener(UI_EVENTS.openSettings, listener) }
  })
  it('keeps task hosting an independent explicit choice', async () => {
    await renderGate(); await clickElement(byId('phone-setup-enable-host')!)
    expect(readPhoneDeviceSettings(mocks.owner)).toMatchObject({ enabled: false, hostEnabled: true })
    expect(Object.values(readPhoneDeviceSettings(mocks.owner).groups).every(value => !value)).toBe(true)
  })
  it('keeps dismissal bound to the actual installation', async () => {
    const h = await renderGate(); await clickElement(document.querySelector<HTMLElement>('[aria-label="返回咕咕"]')!); h.cleanup()
    await renderGate(); expect(byId('phone-agent-setup-form')).toBeNull()
    mocks.installKey = 'another-install'; await renderGate(); expect(byId('phone-agent-setup-form')).not.toBeNull()
  })
  it('reopens correctly after switching owners with different request counts', async () => {
    const previous = 'previous-owner', current = 'current-owner', install = phoneInstallId(mocks.installKey, `registration-${mocks.installKey}`)
    savePhoneAgentSetup(previous, install, { step: 'tools', completed: true, dismissed: true }); savePhoneAgentSetup(current, install, { step: 'tools', completed: true, dismissed: true })
    const h = await renderGate(previous)
    await waitForCondition(() => byId('main-product')?.dataset.owner === previous, 'previous account loaded')
    await act(async () => { openPhoneAgentSetup(previous); openPhoneAgentSetup(previous) })
    await clickElement(document.querySelector<HTMLElement>('[aria-label="返回咕咕"]')!)
    await h.render(createNode(PhoneAgentSetupGate, { ownerId: current, children: createElement(Product) }))
    await waitForCondition(() => byId('main-product')?.dataset.owner === current, 'new account loaded')
    await act(async () => openPhoneAgentSetup(current)); expect(byId('phone-agent-setup-form')).not.toBeNull()
  })
  it('does not show a permissions page on the web', async () => {
    mocks.kind = 'web'; mocks.permissions.splice(0); const h = await render(); expect(h.container.textContent).toBe('')
  })
})

describe('phone permission actions and real Android state', () => {
  it('lists three system permissions and ten distinct phone capability permissions, without changing consent on mount', async () => {
    await render()
    for (const row of PHONE_PERMISSION_ROWS) expect(byId(`phone-device-group-${row.id}`)?.textContent).toContain(row.purpose)
    for (const p of mocks.permissions) expect(byId(`phone-device-system-${p}`)).not.toBeNull()
    expect(byId('phone-permissions-list')?.querySelectorAll('[role="button"]')).toHaveLength(13)
    expect(byId('phone-permissions-list')?.textContent).toContain('这台手机上的任务 Agent 能用')
    expect(readPhoneDeviceSettings(mocks.owner)).toMatchObject({ enabled: false, hostEnabled: false })
    expect(mocks.runtimeRequest).not.toHaveBeenCalled(); expect(mocks.dataRequest).not.toHaveBeenCalled(); expect(mocks.nativeSettings).not.toHaveBeenCalled()
  })
  it('distinguishes real system grants from a category not yet enabled for tasks', async () => {
    mocks.os!.runtime.calendar = 'granted'; await render()
    expect(byId('phone-device-group-calendar')?.textContent).toContain('未开启')
    await clickElement(byId('phone-device-group-calendar')!)
    expect(readPhoneDeviceSettings(mocks.owner).groups.calendar).toBe(true)
    expect(mocks.runtimeRequest).not.toHaveBeenCalled(); expect(mocks.nativeSettings).not.toHaveBeenCalled()
  })
  it('requests calendar for the explicit choice and does not revive disabled cached contacts', async () => {
    setPhoneActionGroup(mocks.owner, 'contacts', true); setPhoneDeviceEnabled(mocks.owner, false)
    mocks.runtimeRequest.mockImplementationOnce(async () => { mocks.os!.runtime.calendar = 'granted'; return {} })
    await render(); await clickElement(byId('phone-device-group-calendar')!)
    expect(mocks.runtimeRequest).toHaveBeenCalledExactlyOnceWith({ permissions: ['calendar'] })
    expect(readPhoneDeviceSettings(mocks.owner)).toMatchObject({ enabled: true, hostEnabled: false, groups: { calendar: true, contacts: false } })
  })
  it('opens notification reading and DND separately from their own rows', async () => {
    await render(); await clickElement(byId('phone-device-group-notifications')!)
    expect(mocks.nativeSettings).toHaveBeenLastCalledWith({ target: 'notification_listener' })
    await clickElement(byId('phone-device-group-dnd')!)
    expect(mocks.nativeSettings).toHaveBeenLastCalledWith({ target: 'dnd' })
    expect(readPhoneDeviceSettings(mocks.owner).enabled).toBe(false)
  })
  it('requests Android media access and opens app settings on rejection, without saving a false grant', async () => {
    mocks.dataRequest.mockResolvedValue({ supported: true, images: false, videos: false, selected: false })
    await render(); await clickElement(byId('phone-device-group-photos')!)
    expect(mocks.dataRequest).toHaveBeenCalledExactlyOnceWith({ group: 'photos' }); expect(mocks.nativeSettings).toHaveBeenCalledExactlyOnceWith({ target: 'app' })
    expect(readPhoneDeviceSettings(mocks.owner)).toMatchObject({ enabled: false, groups: { photos: false } })
    expect(byId('phone-device-group-photos')?.textContent).toContain('未开启')
  })
  it('saves photos only after Android actually grants access and reflects limited access', async () => {
    mocks.dataRequest.mockImplementationOnce(async () => { mocks.os!.data!.selected = true; return mocks.os!.data })
    await render(); await clickElement(byId('phone-device-group-photos')!)
    expect(readPhoneDeviceSettings(mocks.owner).groups.photos).toBe(true)
    expect(byId('phone-device-group-photos')?.textContent).toContain('已开启')
    expect(mocks.nativeSettings).not.toHaveBeenCalled()
  })
  it('refreshes native and system states after foreground, without requesting again', async () => {
    await render(); await clickElement(byId('phone-device-system-camera')!); expect(mocks.request).toHaveBeenCalledExactlyOnceWith('camera')
    const before = mocks.refresh.mock.calls.length; mocks.os!.runtime.contacts = 'granted'; mocks.check.mockResolvedValue('granted')
    await act(async () => { for (const f of mocks.foreground) f() })
    expect(mocks.refresh.mock.calls.length).toBeGreaterThan(before)
    expect(byId('phone-device-group-contacts')?.textContent).toContain('未开启')
    expect(byId('phone-device-system-camera')?.textContent).toContain('已开启')
    expect(mocks.request).toHaveBeenCalledTimes(1)
  })
  it('keeps unreadable rows visible and reports one combined failure', async () => {
    mocks.refresh.mockRejectedValue(new Error('read failed')); mocks.check.mockRejectedValue(new Error('system failed')); await render()
    expect(byId('phone-device-group-photos')?.textContent).toContain('查不到')
    expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1)
    expect(mocks.request).not.toHaveBeenCalled()
  })
})
