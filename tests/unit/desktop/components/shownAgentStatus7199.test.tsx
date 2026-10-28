// @vitest-environment jsdom
// #7199 画状态前的那一道映射:自己的 agent 读数「不在线」、而它住的那台云端宿主只是闲时收回着(管家说 asleep / waking)
// ⇒ 不画状态(❌ 睡团 / 「不在线」,也 ❌「在线」);叫醒被拒 / 出错(管家报 error ⇒ 设备行上没有 cloud_computer)、
// 别人的 agent、非离线的读数一律照读数画。
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Device } from '@gugu/core/shared/types/chat'
import { presentAgentStatus } from '@gugu/core/shared/agentStatusPresentation'
import { contact, contactsStore, createReactHarness, device } from '../../../support/testHarness'
import { ContactsContext } from '../../../../apps/desktop/src/store/contactsContext'
import { DevicesContext, type DevicesContextValue } from '../../../../apps/desktop/src/store/devicesContext'

vi.mock('../../../../apps/desktop/src/lib/cloudComputerStore', () => ({ refreshCloudComputer: vi.fn(async () => null) }))

const { useAgentsOnCloudComputer, useShownAgentStatus } = await import('../../../../apps/desktop/src/components/chat/useAgentsOnCloudComputer')

let shown: ReturnType<typeof useShownAgentStatus>
function Probe() {
  shown = useShownAgentStatus()
  return null
}

function devicesStore(devices: Device[]): DevicesContextValue {
  return { devices, loading: false, error: null, refresh: vi.fn(async () => {}), rename: vi.fn(async () => {}), remove: vi.fn(async () => {}), listBoundAgents: vi.fn(async () => []) }
}

const offline = presentAgentStatus({ reading: null, reachability: 'offline' })
const erroring = presentAgentStatus({ reading: { status: 'error', detail: null }, reachability: 'online' })

async function render(cloud: Device['cloud_computer']) {
  const devices = [device('cloud-1', [], { is_online: false, ...(cloud ? { cloud_computer: cloud } : {}) }), device('laptop', [], { is_online: false })]
  const contacts = [
    contact({ id: 'assistant', type: 'agent', device_id: 'cloud-1' }),
    contact({ id: 'laptop-agent', type: 'agent', device_id: 'laptop' }),
  ]
  await harness.render(createElement(ContactsContext.Provider, { value: contactsStore({ contacts }) },
    createElement(DevicesContext.Provider, { value: devicesStore(devices) }, createElement(Probe))))
}

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => harness.cleanup())

describe('#7199 宿主闲时收回着 ≠ 不在线(只管画)', () => {
  it('keeps the archived label visible even when the cloud host is asleep', async () => {
    await render('asleep')
    const archived = presentAgentStatus({ reading: { status: 'working', detail: 'running' }, reachability: 'archived' })
    expect(shown.status('assistant', 'archived')).toBe('archived')
    expect(shown.presentation('assistant', archived)).toMatchObject({ label: 'archived', animate: false })
  })
  it.each(['asleep', 'waking'] as const)('宿主 %s:不画状态 —— 没有粗分类、没有 presentation', async (cloud) => {
    await render(cloud)
    expect(shown.status('assistant', 'offline')).toBeUndefined()
    expect(shown.presentation('assistant', offline)).toBeNull()
  })

  it('阴控:设备行上没有收回着的信号(叫醒被拒 / 出错时管家报 error、不是云电脑)= 照读数说不在线', async () => {
    await render(undefined)
    expect(shown.status('assistant', 'offline')).toBe('offline')
    expect(shown.presentation('assistant', offline)).toBe(offline)
  })

  it('阴控:同一台收回着,别的读数(出错)、别台上的 agent、不在通讯录里的 agent 都照读数画', async () => {
    await render('asleep')
    expect(shown.status('assistant', 'error')).toBe('error')
    expect(shown.presentation('assistant', erroring)).toBe(erroring)
    expect(shown.status('laptop-agent', 'offline')).toBe('offline')
    expect(shown.status('someone-elses-agent', 'offline')).toBe('offline')
  })

  it('逐行调用共享一次派生(列表没有虚拟化):同一份通讯录 + 设备表只算一次;设备表换了才重算', async () => {
    const seen: ReadonlyMap<string, unknown>[] = []
    function Row() {
      seen.push(useAgentsOnCloudComputer())
      return null
    }
    const contacts = [contact({ id: 'assistant', type: 'agent', device_id: 'cloud-1' })]
    const tree = (devices: Device[]) => createElement(ContactsContext.Provider, { value: contactsStore({ contacts }) },
      createElement(DevicesContext.Provider, { value: devicesStore(devices) }, createElement(Row), createElement(Row)))
    const asleep = [device('cloud-1', [], { is_online: false, cloud_computer: 'asleep' })]
    await harness.render(tree(asleep))
    expect(seen).toHaveLength(2)
    expect(seen[1]).toBe(seen[0])
    expect(seen[0].get('assistant')).toBe('asleep')

    await harness.render(tree([device('cloud-1', [], { is_online: true, cloud_computer: 'awake' })]))
    expect(seen.at(-1)).not.toBe(seen[0])
    expect(seen.at(-1)?.size).toBe(0)
  })

  it('一组读数:按 id 取的那份里收回着的缺席;群汇总只把收回着的那位拿出去,读数原样', async () => {
    await render('asleep')
    const statuses = { assistant: 'offline', 'laptop-agent': 'offline' } as const
    expect(shown.statuses(statuses)).toEqual({ 'laptop-agent': 'offline' })
    expect(shown.members(['assistant', 'laptop-agent'], statuses)).toEqual(['laptop-agent'])
    expect(shown.members([{ id: 'assistant' }], statuses)).toEqual([])
  })
})
