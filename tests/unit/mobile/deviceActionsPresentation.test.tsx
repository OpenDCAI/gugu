import { useAssistantPanelPage } from '../../../apps/desktop/src/lib/assistantPanelPage'
// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { SettingsDetailNavigation, type SettingsDetailState } from '../../../apps/desktop/src/components/settings/SettingsDetailNavigation'
import type { Device } from '@gugu/core/shared/types/chat'
import { DeviceActionsPage, ThisDeviceActions } from '../../../apps/desktop/src/components/settings/DeviceActionsPage'
import { PermissionsSection } from '../../../apps/desktop/src/components/settings/PermissionsSection'
import type { DeviceActionsState } from '../../../apps/desktop/src/lib/deviceActionsIpc'
import { UI_EVENTS } from '../../../apps/desktop/src/lib/uiEvents'
import { clickElement, createReactHarness } from '../../support/testHarness'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), reload: vi.fn(), state: { supported: true, platform: 'darwin', denyAll: false, groups: [], recent: [] } as DeviceActionsState }))
vi.mock('../../../apps/desktop/src/platform', () => ({ platform: { kind: 'electron', capabilities: { agentRuntime: false }, systemPermissions: ['notifications'], checkSystemPermission: async () => 'granted', subscribeAppForeground: () => () => {} } }))
vi.mock('../../../apps/desktop/src/mobile/phone-device/PhonePermissionsList', () => ({ PhonePermissionsList: () => null }))
vi.mock('../../../apps/desktop/src/platform/desktopIpc', () => ({ desktopIpc: () => ({ invoke: mocks.invoke }) }))
vi.mock('../../../apps/desktop/src/hooks/useThisDeviceActions', () => ({ useThisDeviceState: () => ({ state: mocks.state, reload: mocks.reload }) }))
vi.mock('../../../apps/desktop/src/components/assistant/assistant-app-client', () => ({ reportAssistantAppChange: vi.fn(async () => {}) }))

let h: ReturnType<typeof createReactHarness>
beforeEach(() => { h = createReactHarness(); vi.clearAllMocks(); mocks.state.groups = []; mocks.state.denyAll = false; mocks.invoke.mockResolvedValue(undefined) })
afterEach(() => h.cleanup())
const device = (online: boolean, phone = false) => ({ device_id: 'remote', label: 'Remote', is_online: online, platform: phone ? 'android' : 'darwin',
  capabilities: { host_kind: phone ? 'phone' : 'desktop', actions: { actions: [{ name: 'calendar.list', title: 'Calendar', group: 'calendar', available: true }] } },
}) as Device

it('does not mark a cached available action as usable while the device is offline', async () => {
  await h.render(<DeviceActionsPage device={device(false)} isThisDevice={false} embedded />)
  const row = h.container.querySelector('[data-testid="settings-device-action-other-calendar"]')!
  expect(row.textContent).toContain('离线')
  expect(row.textContent).not.toContain('可用')
  expect(h.container.querySelector('[data-testid="settings-device-actions-back"]')).toBeNull()
  expect(h.container.textContent).not.toContain('Remote')
  await h.render(<DeviceActionsPage device={device(true)} isThisDevice={false} embedded />)
  expect(h.container.querySelector('[data-testid="settings-device-action-other-calendar"]')?.textContent).toContain('可用')
})

it('does not expose another phone as an assistant action list even when it reports grants', async () => {
  await h.render(<DeviceActionsPage device={device(true, true)} isThisDevice={false} />)
  expect(h.container.querySelector('[data-testid="settings-device-action-other-calendar"]')).toBeNull()
  expect(h.container.textContent).toContain('这台手机上的任务 Agent')
  expect(h.container.textContent).not.toContain('可用')
})

it('shows one failure for a failed permission write and does not emit a success warning', async () => {
  await h.render(<ThisDeviceActions bare managePermissions />)
  const toggle = () => h.container.querySelector<HTMLElement>('[data-testid="settings-device-actions-deny-all"] [role="switch"]')!
  mocks.invoke.mockRejectedValueOnce(new Error('Permission write failed'))
  await clickElement(toggle())
  expect(h.container.querySelectorAll('[role="alert"]')).toHaveLength(1)
  expect(mocks.reload).not.toHaveBeenCalled()
  await clickElement(toggle())
  expect(h.container.querySelectorAll('[role="alert"]')).toHaveLength(0)
  expect(mocks.reload).toHaveBeenCalledTimes(1)
})

it('uses the panel toolbar for desktop device navigation and keeps one current title', async () => {
  const toolbar = createReactHarness(), back = vi.fn()
  function Toolbar() { const page = useAssistantPanelPage(); return page ? <button onClick={page.back}>返回</button> : null }
  try {
    await toolbar.render(<Toolbar />)
    await h.render(<ThisDeviceActions panelNavigation onBack={back} />)
    expect(h.container.querySelectorAll('h1')).toHaveLength(1)
    expect(h.container.querySelector('[data-testid="settings-device-actions-back"]')).toBeNull()
    await clickElement(toolbar.container.querySelector('button')!)
    expect(back).toHaveBeenCalledTimes(1)
  } finally { toolbar.cleanup() }
})

it('shows only granted capabilities in device pages and points to the one permission manager', async () => {
  mocks.state.groups = [
    { id: 'calendar', connected: true, blocked: null, actions: [] },
    { id: 'files.documents', connected: false, blocked: null, actions: [] },
  ]
  const open = vi.fn()
  window.addEventListener(UI_EVENTS.openSettings, open)
  try {
    await h.render(<ThisDeviceActions />)
    expect(h.container.querySelector('[data-testid="device-granted-calendar"]')).not.toBeNull()
    expect(h.container.querySelector('[data-testid="device-granted-files.documents"]')).toBeNull()
    expect(h.container.querySelector('[role="switch"]')).toBeNull()
    expect(h.container.querySelector('[data-testid="settings-device-action-group-calendar"]')).toBeNull()
    await clickElement(h.container.querySelector<HTMLElement>('[data-testid="device-open-permissions"]')!)
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ detail: { section: 'permissions' } }))
    expect(mocks.invoke).not.toHaveBeenCalled()
  } finally { window.removeEventListener(UI_EVENTS.openSettings, open) }
})

it('keeps system permissions and every task grant together, including folder authorization', async () => {
  const ids = ['calendar', 'reminders', 'contacts', 'notes', 'mail', 'messages', 'files.desktop', 'files.documents', 'files.downloads', 'files.other']
  mocks.state.groups = ids.map(id => ({ id, connected: false, blocked: null, actions: [] }))
  mocks.invoke.mockResolvedValue({ ok: true })
  await h.render(<PermissionsSection />)
  expect(h.container.querySelector('[data-testid="settings-permission-notifications"]')).not.toBeNull()
  for (const id of ids) expect(h.container.querySelector(`[data-testid="settings-device-action-group-${id}"]`)).not.toBeNull()
  await clickElement(h.container.querySelector<HTMLElement>('[data-testid="settings-device-action-group-files.documents"]')!)
  await clickElement(h.container.querySelector<HTMLElement>('[data-testid="settings-device-action-connect-files.documents"]')!)
  expect(mocks.invoke).toHaveBeenCalledWith('device-actions:connect', 'files.documents')
  expect(mocks.reload).toHaveBeenCalledTimes(1)
  expect(h.container.querySelector('[data-testid="settings-device-action-detail-back"]')?.textContent).toContain('权限')
})

it('lets the permissions frame own a single title and its back action', async () => {
  mocks.state.groups = [{ id: 'files.documents', connected: false, blocked: null, actions: [] }]
  function Frame() {
    const [detail, setDetail] = useState<SettingsDetailState>(null)
    return <><h1>{detail?.title ?? '权限'}</h1>{detail && <button data-testid="permission-toolbar-back" onClick={detail.back}>返回</button>}
      <SettingsDetailNavigation.Provider value={setDetail}><ThisDeviceActions bare managePermissions /></SettingsDetailNavigation.Provider></>
  }
  await h.render(<Frame />)
  await clickElement(h.container.querySelector<HTMLElement>('[data-testid="settings-device-action-group-files.documents"]')!)
  expect(h.container.querySelector('h1')?.textContent).toBe('文稿')
  expect(h.container.querySelector('[data-testid="settings-device-action-detail-back"]')).toBeNull()
  await clickElement(h.container.querySelector<HTMLElement>('[data-testid="permission-toolbar-back"]')!)
  expect(h.container.querySelector('h1')?.textContent).toBe('权限')
  expect(h.container.querySelector('[data-testid="settings-device-action-group-files.documents"]')).not.toBeNull()
})


it('uses product names for public versions while retaining development and unknown version labels', async () => {
  const tiers = ['production', 'beta', 'acceptance-tasks431', undefined]
  await h.render(<DeviceActionsPage device={device(true)} isThisDevice={false} embedded
    configurations={tiers.map((tier, index) => ({ ...device(true), device_id: `version-${index}`, tier }))} />)
  const versions = h.container.querySelector('[data-testid="device-machine-configurations"]')!
  expect(versions.textContent).toContain('版本')
  for (const [index, title] of ['咕咕', '咕咕 Beta', 'acceptance-tasks431', '版本未知'].entries()) {
    expect(versions.querySelector(`[data-testid="device-configuration-version-${index}"] .gg-settings-row-title`)?.textContent).toBe(title)
  }
})


it('keeps grants separate when selecting another version and never changes a permission', async () => {
  const base = device(true)
  const beta = { ...base, device_id: 'beta', tier: 'beta' }
  const production = { ...base, device_id: 'production', tier: 'production', capabilities: { ...base.capabilities,
    actions: { actions: [{ name: 'calendar.list', title: 'Calendar', group: 'calendar', available: false, unavailable_reason: 'not_granted' }] } } } as Device
  await h.render(<DeviceActionsPage device={production} isThisDevice={false} embedded configurations={[beta, production]} />)
  const selected = (id: string) => h.container.querySelector<HTMLElement>(`[data-testid="device-configuration-${id}"]`)!
  const calendar = () => h.container.querySelector('[data-testid="settings-device-action-other-calendar"]')!.textContent
  expect(selected('production').getAttribute('aria-pressed')).toBe('true')
  expect(calendar()).toContain('未授权')
  await clickElement(selected('beta'))
  expect(selected('beta').getAttribute('aria-pressed')).toBe('true')
  expect(selected('production').getAttribute('aria-pressed')).toBe('false')
  expect(calendar()).toContain('可用')
  await clickElement(selected('production'))
  expect(calendar()).toContain('未授权')
  expect(mocks.invoke).not.toHaveBeenCalled()
})

it('uses native grants only for the app version that is actually running here', async () => {
  mocks.state.groups = [{ id: 'calendar', connected: true, blocked: null, actions: [] }]
  const local = { ...device(true), device_id: 'local', tier: 'production', is_current_device: true }
  const beta = { ...device(true), device_id: 'beta', tier: 'beta', is_current_device: false, capabilities: { ...device(true).capabilities,
    actions: { actions: [{ name: 'calendar.list', title: 'Calendar', group: 'calendar', available: false, unavailable_reason: 'not_granted' }] } } } as Device
  await h.render(<DeviceActionsPage device={local} isThisDevice configurations={[local, beta]} />)
  expect(h.container.querySelector('[data-testid="device-granted-calendar"]')).not.toBeNull()
  await clickElement(h.container.querySelector<HTMLElement>('[data-testid="device-configuration-beta"]')!)
  expect(h.container.querySelector('[data-testid="device-granted-calendar"]')).toBeNull()
  expect(h.container.querySelector('[data-testid="settings-device-action-other-calendar"]')!.textContent).toContain('未授权')
  await clickElement(h.container.querySelector<HTMLElement>('[data-testid="device-configuration-local"]')!)
  expect(h.container.querySelector('[data-testid="device-granted-calendar"]')).not.toBeNull()
  expect(mocks.invoke).not.toHaveBeenCalled()
})

it('separates missing grants from unavailable or system-blocked capabilities in the permission manager',async()=>{
 mocks.state.groups=[{id:'notes',connected:false,blocked:null,actions:[]},
  {id:'calendar',connected:false,blocked:{reason:'unsupported'},actions:[]},
  {id:'contacts',connected:false,blocked:{reason:'os_permission'},actions:[]}] as DeviceActionsState['groups']
 await h.render(<ThisDeviceActions bare managePermissions />)
 const group=(id:string)=>h.container.querySelector(`[data-testid="settings-device-actions-${id}"]`)!
 expect(group('available').textContent).toContain('备忘录')
 expect(group('available').textContent).not.toContain('暂时用不了')
 expect(group('unsupported').textContent).toContain('日历')
 expect(group('system-blocked').textContent).toContain('通讯录')
 expect(h.container.textContent).not.toContain('任务 Agent')
})
