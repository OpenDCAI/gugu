// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Device } from '@gugu/core/shared/types/chat'
import { DeviceActionsPage, ThisDeviceActions } from '../../../apps/desktop/src/components/settings/DeviceActionsPage'
import { clickElement, createReactHarness } from '../../support/testHarness'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), reload: vi.fn(), state: { supported: true, denyAll: false, groups: [], recent: [] } }))
vi.mock('../../../apps/desktop/src/platform/desktopIpc', () => ({ desktopIpc: () => ({ invoke: mocks.invoke }) }))
vi.mock('../../../apps/desktop/src/hooks/useThisDeviceActions', () => ({ useThisDeviceState: () => ({ state: mocks.state, reload: mocks.reload }) }))
vi.mock('../../../apps/desktop/src/components/assistant/assistant-app-client', () => ({ reportAssistantAppChange: vi.fn(async () => {}) }))

let h: ReturnType<typeof createReactHarness>
beforeEach(() => { h = createReactHarness(); vi.clearAllMocks(); mocks.invoke.mockResolvedValue(undefined) })
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
  await h.render(<ThisDeviceActions bare />)
  const toggle = () => h.container.querySelector<HTMLElement>('[data-testid="settings-device-actions-deny-all"] [role="switch"]')!
  mocks.invoke.mockRejectedValueOnce(new Error('Permission write failed'))
  await clickElement(toggle())
  expect(h.container.querySelectorAll('[role="alert"]')).toHaveLength(1)
  expect(mocks.reload).not.toHaveBeenCalled()
  await clickElement(toggle())
  expect(h.container.querySelectorAll('[role="alert"]')).toHaveLength(0)
  expect(mocks.reload).toHaveBeenCalledTimes(1)
})
