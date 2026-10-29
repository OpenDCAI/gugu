// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AssistantDevicesPage } from '../../../apps/desktop/src/components/devices/AssistantDevicesPage'
import { createReactHarness, clickElement, renderWithAppProviders } from '../../support/testHarness'

const state = vi.hoisted(() => ({ phones: [] as unknown[], devices: [] as unknown[], kind: 'capacitor' }))
vi.mock('../../../apps/desktop/src/platform', () => ({ platform: { get kind() { return state.kind }, capabilities: {} } }))
vi.mock('../../../apps/desktop/src/store/devicesContext', () => ({ useDevicesStore: () => state }))
vi.mock('../../../apps/desktop/src/hooks/useThisDeviceActions', () => ({ useThisDeviceState: () => ({ state: null }) }))
vi.mock('../../../apps/desktop/src/mobile/phone-device/PhoneDeviceActionsPage', () => ({ PhoneDeviceActionsPage: () => <div data-testid="local-phone-permissions" /> }))
vi.mock('../../../apps/desktop/src/components/devices/ConnectMoreDevices', () => ({ ConnectMoreDevices: () => null }))
vi.mock('../../../apps/desktop/src/components/settings/DeviceActionsPage', () => ({ ThisDeviceActions: () => <div data-testid="local-computer-permissions" />, DeviceActionsPage: ({ device }: { device: { label: string } }) => <div data-testid="remote-permissions">{device.label}</div> }))

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness(); state.phones = []; state.devices = []; state.kind = 'capacitor' })
afterEach(() => harness.cleanup())
const find = (id: string) => harness.container.querySelector<HTMLElement>(`[data-testid="${id}"]`)

it('opens phone permissions before this phone has registered a device row', async () => {
  await renderWithAppProviders(harness, <AssistantDevicesPage cloudDeviceId={null} />)
  await clickElement(find('assistant-device-this-phone')!)
  expect(find('local-phone-permissions')).not.toBeNull()
  await clickElement(find('assistant-devices-back')!)
  expect(find('assistant-device-this-phone')).not.toBeNull()
})

it('shows the current phone once without advertising remote phone actions', async () => {
  const phone = { is_online: true, capabilities: { host_kind: 'phone', runtimes: [], terminals: [], host_runtime_capability: 0, actions: { actions: [] } } }
  state.phones = [{ ...phone, device_id: 'local', label: 'Current phone', is_current_device: true },
    { ...phone, device_id: 'other', label: 'Other phone' }]
  await renderWithAppProviders(harness, <AssistantDevicesPage cloudDeviceId={null} />)
  expect(find('assistant-device-this-phone')!.textContent).toContain('Current phone')
  expect(find('assistant-device-local')).toBeNull()
  expect(find('assistant-device-other')!.textContent).not.toContain('已授权')
  expect(find('remote-permissions')).toBeNull()
  // Every device opens its own page (rename lives in its header), even one with no action list to show.
  await clickElement(find('assistant-device-other')!)
  expect(find('remote-permissions')!.textContent).toBe('Other phone')
})

it('lets the phone shell own device detail navigation without an inner back header', async () => {
  const open = vi.fn()
  await renderWithAppProviders(harness, <AssistantDevicesPage cloudDeviceId={null} openedDeviceId={null} onOpenDevice={open} />)
  await clickElement(find('assistant-device-this-phone')!)
  expect(open).toHaveBeenCalledWith('this-phone')
  await renderWithAppProviders(harness, <AssistantDevicesPage cloudDeviceId={null} openedDeviceId="this-phone" onOpenDevice={open} />)
  expect(find('local-phone-permissions')).not.toBeNull()
  expect(find('assistant-devices-back')).toBeNull()
})

it('keeps desktop authorization reachable before device registration', async () => {
  state.kind = 'electron'
  await renderWithAppProviders(harness, <AssistantDevicesPage cloudDeviceId={null} panelNavigation />)
  await clickElement(find('assistant-device-this-computer')!)
  expect(find('local-computer-permissions')).not.toBeNull()
})

it('shows same-machine tiers once on both phone and desktop, using the online row', async () => {
  const capabilities = { terminals: [], runtimes: [], actions: { actions: [] } }
  state.devices = [{ device_id: 'acceptance', machine_id: 'same-mac', label: 'Mac', is_online: false, last_seen_at: '2026-10-27', capabilities },
    { device_id: 'beta', machine_id: 'same-mac', label: 'Mac', is_online: true, last_seen_at: '2026-10-26', capabilities }]
  for (const kind of ['capacitor', 'electron']) {
    state.kind = kind
    const open = vi.fn()
    await renderWithAppProviders(harness, <AssistantDevicesPage cloudDeviceId={null} onOpenDevice={open} />)
    expect(find('assistant-device-acceptance')).toBeNull()
    expect(find('assistant-device-beta')!.textContent).toContain('2 个版本')
    await clickElement(find('assistant-device-beta')!)
    expect(open).toHaveBeenCalledWith('beta')
  }
})

it('folds eight-day offline machines by default and moves a returning endpoint to the normal list', async () => {
  state.devices = [{ device_id: 'old', machine_id: 'old-mac', label: 'Old Mac', is_online: false,
    last_seen_at: new Date(Date.now() - 8 * 86400000).toISOString(), capabilities: { terminals: [], runtimes: [] } }]
  await renderWithAppProviders(harness, <AssistantDevicesPage cloudDeviceId={null} />)
  expect(find('device-long-offline-toggle')!.getAttribute('aria-expanded')).toBe('false')
  expect(find('device-long-offline')!.contains(find('assistant-device-old'))).toBe(true)
  state.devices = [{ ...(state.devices[0] as object), is_online: true, last_seen_at: new Date().toISOString() }]
  await renderWithAppProviders(harness, <AssistantDevicesPage cloudDeviceId={null} />)
  expect(find('device-long-offline')).toBeNull()
  expect(find('assistant-device-old')).not.toBeNull()
})
