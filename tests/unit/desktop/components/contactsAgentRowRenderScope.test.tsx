// @vitest-environment jsdom
// 通讯录 agent 行的重渲染范围:一个 agent 变了只重画那一行;设备表心跳不重画任何一行。
// 从前改一个名字整列每行都重画(100 个 agent = 每次 100 行),n 个 agent 各推一次就是 O(n²)。
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Device } from '@gugu/core/shared/types/chat'
import type { ContactUser } from '@gugu/core/shared/types/contacts'
import { ContactsPanel } from '../../../../apps/desktop/src/components/ContactsPanel'
import { DevicesContext, type DevicesContextValue } from '../../../../apps/desktop/src/store/devicesContext'
import { clickElement, contact, createNode, createReactHarness, device, renderWithAppProviders } from '../../../support/testHarness'

const rowRenders = vi.hoisted(() => new Map<string, number>())
vi.mock('../../../../apps/desktop/src/components/ui/ListRow', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../../apps/desktop/src/components/ui/ListRow')>()
  return {
    ...original,
    ListRow: (props: Parameters<typeof original.ListRow>[0] & { 'data-contact-id'?: string }) => {
      const id = props['data-contact-id']
      if (id) rowRenders.set(id, (rowRenders.get(id) ?? 0) + 1)
      return original.ListRow(props)
    },
  }
})
vi.mock('../../../../apps/desktop/src/lib/chat', () => import('../../../support/contactsChatServiceTestDouble'))
vi.mock('../../../../apps/desktop/src/hooks/useAgentDisplayStatus', () => import('../../../support/agentDisplayStatusTestDouble'))

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness(); rowRenders.clear() })
afterEach(() => { harness.cleanup() })

const devicesStore = (devices: Device[]): DevicesContextValue => ({
  devices, loading: false, error: null, refresh: vi.fn(), rename: vi.fn(), remove: vi.fn(), listBoundAgents: vi.fn(),
})
const agents = ['a', 'b', 'c'].map((id) => contact({ id, type: 'agent', display_name: `Agent ${id}`, owner_user_id: 'owner-1', device_id: 'laptop' }))

// 设备段默认收起、收起时只挂轻行(见 ContactsDeviceSections @@@folded-rows):先点开,完整行才在。
async function openDeviceSection() {
  await clickElement(harness.container.querySelector('[data-testid="contacts-device-section"] [data-slot="section-label"]') as HTMLElement)
}

async function render(contacts: ContactUser[], devices: Device[]) {
  await renderWithAppProviders(harness, createElement(DevicesContext.Provider, { value: devicesStore(devices) }, createNode(ContactsPanel, {})), {
    shellTab: 'contacts',
    auth: { id: 'owner-1', email: 'owner@example.com', nickname: 'Owner' },
    contacts: { contacts },
    chat: { chats: [] },
  })
}

describe('contacts agent rows re-render only for their own change', () => {
  it('renaming one agent re-renders that row only', async () => {
    const devices = [device('laptop', [], { is_online: true })]
    await render(agents, devices)
    await openDeviceSection()
    expect([...rowRenders.keys()].sort()).toEqual(['a', 'b', 'c'])
    rowRenders.clear()

    await render([agents[0]!, { ...agents[1]!, display_name: 'Renamed b' }, agents[2]!], devices)
    expect(harness.container.querySelector('[data-contact-id="b"]')?.textContent).toContain('Renamed b')
    expect(Object.fromEntries(rowRenders)).toEqual({ b: 1 })
  })

  it('a device heartbeat (new device list, same facts) re-renders no row', async () => {
    await render(agents, [device('laptop', [], { is_online: true, last_seen_at: '2026-11-05T00:00:00.000Z' })])
    await openDeviceSection()
    expect(rowRenders.size).toBe(3)
    rowRenders.clear()
    await render(agents, [device('laptop', [], { is_online: true, last_seen_at: '2026-11-05T00:00:30.000Z' })])
    expect(Object.fromEntries(rowRenders)).toEqual({})
  })
})
