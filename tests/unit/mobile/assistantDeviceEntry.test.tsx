// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AssistantDevicesPage } from '../../../apps/desktop/src/components/devices/AssistantDevicesPage'
import { createReactHarness, clickElement, renderWithAppProviders } from '../../support/testHarness'

const state = vi.hoisted(() => ({ phones: [] as unknown[], devices: [] as unknown[] }))
vi.mock('../../../apps/desktop/src/platform', () => ({ platform: { kind: 'capacitor', capabilities: {} } }))
vi.mock('../../../apps/desktop/src/store/devicesContext', () => ({ useDevicesStore: () => state }))
vi.mock('../../../apps/desktop/src/hooks/useThisDeviceActions', () => ({ useThisDeviceState: () => ({ state: null }) }))
vi.mock('../../../apps/desktop/src/mobile/phone-device/PhoneDeviceActionsPage', () => ({ PhoneDeviceActionsPage: () => <div data-testid="local-phone-permissions" /> }))
vi.mock('../../../apps/desktop/src/components/devices/ConnectMoreDevices', () => ({ ConnectMoreDevices: () => null }))
vi.mock('../../../apps/desktop/src/components/settings/DeviceActionsPage', () => ({ DeviceActionsPage: ({ device }: { device: { label: string } }) => <div data-testid="remote-permissions">{device.label}</div> }))

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness(); state.phones = []; state.devices = [] })
afterEach(() => harness.cleanup())
const find = (id: string) => harness.container.querySelector<HTMLElement>(`[data-testid="${id}"]`)

it('opens phone permissions before this phone has registered a device row', async () => {
  await renderWithAppProviders(harness, <AssistantDevicesPage cloudDeviceId={null} />)
  await clickElement(find('assistant-device-this-phone')!)
  expect(find('local-phone-permissions')).not.toBeNull()
  await clickElement(find('assistant-devices-back')!)
  expect(find('assistant-device-this-phone')).not.toBeNull()
})

it('shows the current phone once and keeps other device permissions reachable', async () => {
  const phone = { is_online: true, capabilities: { host_kind: 'phone', runtimes: [], terminals: [], host_runtime_capability: 0, actions: { actions: [] } } }
  state.phones = [{ ...phone, device_id: 'local', label: 'Current phone', is_current_device: true },
    { ...phone, device_id: 'other', label: 'Other phone' }]
  await renderWithAppProviders(harness, <AssistantDevicesPage cloudDeviceId={null} />)
  expect(find('assistant-device-this-phone')!.textContent).toContain('Current phone')
  expect(find('assistant-device-local')).toBeNull()
  await clickElement(find('assistant-device-other')!)
  expect(find('remote-permissions')!.textContent).toBe('Other phone')
})
