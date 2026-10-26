import { useAssistantPanelPage } from '../../../apps/desktop/src/lib/assistantPanelPage'
// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
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
