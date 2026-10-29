// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useDeviceRemoval } from '@/components/settings/useDeviceRemoval'
import { deviceMachines } from '@gugu/core/shared/deviceMachines'
import { DevicesContext, type DevicesContextValue } from '@/store/devicesContext'
import type { Device } from '@gugu/core/shared/types/chat'

// 别处(比如机器名额满了的提示)按 device_id 移除:同一个确认页;移除整台机器 = 它的每个版本都删掉。
function device(overrides: Partial<Device> = {}): Device {
  return {
    device_id: 'remote', label: 'Remote Mac', hostname: 'remote.local', platform: 'mac', status: 'online',
    last_seen_at: '2026-10-28T00:00:00.000Z', is_online: true, is_current_device: false,
    capabilities: { terminals: [], runtimes: [], host_runtime_capability: 0 },
    ...overrides,
  }
}

function Probe({ ids, devices }: { ids: string[]; devices: Device[] }) {
  const { openRemoveDevices, dialogs } = useDeviceRemoval(deviceMachines(devices))
  return createElement('div', null, createElement('button', { 'data-testid': 'go', onClick: () => openRemoveDevices(ids) }), dialogs)
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

async function confirmWith(ids: string[], devices: Device[], agents: Record<string, number> = {}) {
  const value: DevicesContextValue = {
    devices, loading: false, error: null,
    refresh: vi.fn(async () => {}), rename: vi.fn(async () => {}), remove: vi.fn(async () => {}),
    listBoundAgents: vi.fn(async (id: string) => Array.from({ length: agents[id] ?? 0 }, (_, i) => ({ id: `${id}-a${i}`, display_name: `${id} agent ${i}`, avatar: null }))),
  }
  await act(async () => { root.render(createElement(DevicesContext.Provider, { value }, createElement(Probe, { ids, devices }))) })
  await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="go"]')!.click() })
  await act(async () => { await Promise.resolve() })
  const dialog = document.body.querySelector('[data-testid="settings-device-remove-dialog"]') as HTMLElement
  return { value, dialog }
}

const twoVersions = [device({ device_id: 'old', machine_id: 'm', tier: 'acceptance-tasks431', is_online: false }), device({ device_id: 'new', machine_id: 'm', tier: 'beta' })]

it('every version of the machine: the machine is named, all of its agents are listed, and every endpoint is removed', async () => {
  const { value, dialog } = await confirmWith(['old', 'new'], twoVersions, { old: 1, new: 1 })
  expect(dialog.textContent).toContain('old agent 0')
  expect(dialog.textContent).toContain('new agent 0')
  await act(async () => { dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click() })
  const confirm = Array.from(dialog.querySelectorAll('button')).find(b => b.textContent === '移除这台机器')!
  await act(async () => { confirm.click() })
  await act(async () => { await Promise.resolve() })
  expect(vi.mocked(value.remove).mock.calls).toHaveLength(2)
  expect(value.remove).toHaveBeenCalledWith('old', { cascade: true })
  expect(value.remove).toHaveBeenCalledWith('new', { cascade: true })
  expect(document.body.querySelector('[data-testid="settings-device-remove-dialog"]')).toBeNull()
})

it('one version of it: that version is named and only it is removed; this device is never removed', async () => {
  const { value, dialog } = await confirmWith(['old'], twoVersions)
  expect(dialog.textContent).toContain('移除「Remote Mac」的「acceptance-tasks431」？')
  await act(async () => { Array.from(dialog.querySelectorAll('button')).find(b => b.textContent === '移除这个版本')!.click() })
  await act(async () => { await Promise.resolve() })
  expect(value.remove).toHaveBeenCalledTimes(1)
  expect(value.remove).toHaveBeenCalledWith('old', { cascade: false })
  act(() => root.unmount()); root = createRoot(container)
  const mine = [twoVersions[0]!, device({ device_id: 'me', machine_id: 'm', is_current_device: true })]
  const second = await confirmWith(['old', 'me'], mine)
  await act(async () => { Array.from(second.dialog.querySelectorAll('button')).find(b => b.textContent === '移除这个版本')!.click() })
  await act(async () => { await Promise.resolve() })
  expect(second.value.remove).toHaveBeenCalledTimes(1)
  expect(second.value.remove).toHaveBeenCalledWith('old', { cascade: false })
})
