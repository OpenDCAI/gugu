// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AssistantDevicesPage } from '@/components/devices/AssistantDevicesPage'
import { DevicesContext, type DevicesContextValue } from '@/store/devicesContext'
import type { Device } from '@gugu/core/shared/types/chat'

// 助理的「设备」页:一台机器的多个版本,与「设置 › 设备」同一个移除动作(同一个确认、同一个删除 API)。
function device(overrides: Partial<Device> = {}): Device {
  return {
    device_id: 'remote', label: 'Remote Mac', hostname: 'remote.local', platform: 'mac', status: 'online',
    last_seen_at: '2026-10-28T00:00:00.000Z', is_online: true, is_current_device: false,
    capabilities: { terminals: [], runtimes: [], host_runtime_capability: 0 },
    ...overrides,
  }
}

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

it('opened machine with two versions: each version can be removed through the usual confirmation', async () => {
  const value: DevicesContextValue = {
    devices: [device({ device_id: 'old', machine_id: 'same-mac', tier: 'acceptance-tasks431', is_online: false }), device({ device_id: 'new', machine_id: 'same-mac', tier: 'beta' })],
    loading: false, error: null,
    refresh: vi.fn(async () => {}), rename: vi.fn(async () => {}), remove: vi.fn(async () => {}), listBoundAgents: vi.fn(async () => []),
  }
  await act(async () => {
    root.render(createElement(DevicesContext.Provider, { value }, createElement(AssistantDevicesPage, { cloudDeviceId: null, openedDeviceId: 'old', onOpenDevice: () => {} })))
  })
  const removeOld = container.querySelector<HTMLButtonElement>('[data-testid="device-configuration-remove-old"]')!
  expect(container.querySelector('[data-testid="device-configuration-remove-new"]')).not.toBeNull()
  await act(async () => { removeOld.click() })
  await act(async () => { await Promise.resolve() })
  const dialog = document.body.querySelector('[data-testid="settings-device-remove-dialog"]')!
  expect(dialog.textContent).toContain('移除「Remote Mac」的「acceptance-tasks431」？')
  const confirm = Array.from(dialog.querySelectorAll('button')).find(b => b.textContent === '移除这个版本')!
  await act(async () => { confirm.click() })
  await act(async () => { await Promise.resolve() })
  expect(value.remove).toHaveBeenCalledWith('old', { cascade: false })
})
