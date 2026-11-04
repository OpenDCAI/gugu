// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Device } from '@gugu/core/shared/types/chat'
import type { DeviceProject } from '@gugu/core/shared/types/deviceProject'
import { createReactHarness, renderWithAppProviders } from '../../../support/testHarness'

// #1629 parity on the phone page 助理 → 项目: the list reads the account project directory once and hides the
// assistant's cloud host by device identity. The cloud host id comes from the devices store, never from where the
// assistant lives (a computer-hosted assistant must not hide that computer's projects).

const state = vi.hoisted(() => ({
  devices: [] as unknown[],
  cloudComputer: null as unknown,
  records: {} as Record<string, unknown[]>,
  reads: 0,
}))
vi.mock('../../../../apps/desktop/src/store/devicesContext', () => ({
  useDevicesStore: () => ({ devices: state.devices, phones: [], cloudComputer: state.cloudComputer }),
}))
vi.mock('../../../../apps/desktop/src/lib/deviceProjects', () => ({
  listMyDeviceProjects: async () => { state.reads++; return state.records },
}))

import { PhoneProjects } from '../../../../apps/desktop/src/mobile/assistant/PhoneProjects'

const device = (id: string, extra: Partial<Device> = {}) => ({ device_id: id, label: id, is_online: true, is_current_device: false, cloud_computer: null, capabilities: {}, ...extra })
const project = (localProjectId: string, name: string): DeviceProject => ({
  localProjectId, name, rootPath: `/home/${localProjectId}`, createdAt: '2026-11-01T00:00:00.000Z', chatId: null,
  folders: [{ workspaceId: `${localProjectId}-root`, kind: 'root', path: `/home/${localProjectId}`, attachedAt: null }],
})
const rowIds = (root: HTMLElement) => [...root.querySelectorAll('[data-testid^="assistant-project-"]')]
  .map(node => node.getAttribute('data-testid')).filter(id => id !== 'assistant-project-cloud-index').sort()

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness(); state.reads = 0 })
afterEach(() => { harness.cleanup() })

const renderPage = async () => {
  await renderWithAppProviders(harness, createElement(PhoneProjects, { detail: true }), { auth: { id: 'owner' } })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}

describe('PhoneProjects hides the assistant cloud host', () => {
  it('member: the cloud host (from the cloud snapshot) is not listed, a same-named ordinary project is', async () => {
    state.devices = [device('cloud-host'), device('laptop')]
    state.cloudComputer = { available: true, snapshot: { deviceId: 'cloud-host' }, loadError: null }
    state.records = { 'cloud-host': [project('home', '助理')], laptop: [project('same-name', '助理'), project('paper', 'Paper')] }
    await renderPage()
    expect(rowIds(harness.container)).toEqual(['assistant-project-laptop/paper', 'assistant-project-laptop/same-name'])
    expect(state.reads).toBe(1)
  })

  it('non-member: the assistant lives on the person\'s own computer and every project there stays listed', async () => {
    state.devices = [device('laptop'), device('desk')]
    state.cloudComputer = { available: false, snapshot: null, loadError: null }
    state.records = { laptop: [project('assistant-name', '助理'), project('thesis', 'Thesis')], desk: [project('work', 'Work')] }
    await renderPage()
    expect(rowIds(harness.container)).toEqual(['assistant-project-desk/work', 'assistant-project-laptop/assistant-name', 'assistant-project-laptop/thesis'])
  })
})
