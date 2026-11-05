// @vitest-environment jsdom
// #7199 画状态前的那一道映射:自己的 agent 读数「不在线」、而它住的那台云端宿主只是闲时收回着(管家说 asleep / waking)
// ⇒ 不画状态(❌ 睡团 / 「不在线」,也 ❌「在线」);叫醒被拒 / 出错(管家报 error ⇒ 设备行上没有 cloud_computer)、
// 别人的 agent、非离线的读数一律照读数画。
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Device } from '@gugu/core/shared/types/chat'
import type { ContactUser } from '@gugu/core/shared/types/contacts'
import { presentAgentStatus } from '@gugu/core/shared/agentStatusPresentation'
import { contact, createReactHarness, device } from '../../../support/testHarness'
import { installIdentityDirectoryBridge, publishIdentityDirectory } from '../../../../apps/desktop/src/lib/identityDirectoryBridge'
import type { DisplayIdentity } from '../../../../apps/desktop/src/lib/displayIdentity'
import { publishDirectoryDevices } from '../../../../apps/desktop/src/session/shared/remote-sessions/session-directory'

vi.mock('../../../../apps/desktop/src/lib/cloudComputerStore', () => ({ refreshCloudComputer: vi.fn(async () => null) }))

const { useAgentsOnCloudComputer, useShownAgentStatus } = await import('../../../../apps/desktop/src/components/chat/useAgentsOnCloudComputer')

let shown: ReturnType<typeof useShownAgentStatus>
function Probe() {
  shown = useShownAgentStatus()
  return null
}

// 读的是两个外部目录(身份目录给「agent 住哪台」、设备目录给「那台睡没睡」),壳在这里发布,❌ 通讯录 / 设备 context。
installIdentityDirectoryBridge()
function publish(contacts: ContactUser[], devices: Device[]) {
  act(() => {
    publishIdentityDirectory(Object.fromEntries(contacts.map((c) => [c.id, c as unknown as DisplayIdentity])), null)
    publishDirectoryDevices(devices)
  })
}

const offline = presentAgentStatus({ reading: null, reachability: 'offline' })
const erroring = presentAgentStatus({ reading: { status: 'error', detail: null }, reachability: 'online' })

async function render(cloud: Device['cloud_computer']) {
  const devices = [device('cloud-1', [], { is_online: false, ...(cloud ? { cloud_computer: cloud } : {}) }), device('laptop', [], { is_online: false })]
  const contacts = [
    contact({ id: 'assistant', type: 'agent', device_id: 'cloud-1' }),
    contact({ id: 'laptop-agent', type: 'agent', device_id: 'laptop' }),
  ]
  publish(contacts, devices)
  await harness.render(createElement(Probe))
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

  it('逐行调用共享一次派生:每行拿到同一份;设备表换了一份、收回着的没变(心跳)仍是同一份;真变了才换', async () => {
    const seen: ReadonlyMap<string, unknown>[] = []
    function Row() {
      seen.push(useAgentsOnCloudComputer())
      return null
    }
    const contacts = [contact({ id: 'assistant', type: 'agent', device_id: 'cloud-1' })]
    publish(contacts, [device('cloud-1', [], { is_online: false, cloud_computer: 'asleep' })])
    await harness.render(createElement('div', null, createElement(Row), createElement(Row)))
    expect(seen).toHaveLength(2)
    expect(seen[1]).toBe(seen[0])
    expect(seen[0].get('assistant')).toBe('asleep')

    publish(contacts, [device('cloud-1', [], { is_online: false, cloud_computer: 'asleep', last_seen_at: '2026-11-05T00:00:30.000Z' })])
    expect(seen).toHaveLength(2)

    publish(contacts, [device('cloud-1', [], { is_online: true, cloud_computer: 'awake' })])
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
