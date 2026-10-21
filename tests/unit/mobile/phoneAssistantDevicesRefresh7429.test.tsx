// @vitest-environment jsdom
//
// #7429 owner 真机:手机底栏「咕咕」停在开通引导第一页时会抽搐。设备列表每刷新一次(账号里任何一行设备变动)都先变成
// 「在读」,「管家有没有结论」原来跟着它退回「在读」⇒ 引导被卸掉、换成转圈、再挂上(颜色重新随机)。
// 真 usePhoneAssistant,只把它读的几份 store 换成可控的。
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CloudComputerStoreState } from '../../../apps/desktop/src/lib/cloudComputerStore'
import { createReactHarness } from '../../support/testHarness'

const store = vi.hoisted(() => ({
  devices: { loading: false, cloudComputer: undefined as CloudComputerStoreState | undefined },
}))

vi.mock('../../../apps/desktop/src/store/auth', () => ({ useAuth: () => ({ user: { id: 'owner-1', nickname: null } }) }))
vi.mock('../../../apps/desktop/src/store/contactsContext', () => ({ useContactsStore: () => ({ contacts: [] }) }))
vi.mock('../../../apps/desktop/src/store/devicesContext', () => ({
  useDevicesStore: () => ({ devices: [], loading: store.devices.loading, cloudComputer: store.devices.cloudComputer }),
}))
vi.mock('../../../apps/desktop/src/lib/myAssistant', () => ({
  useMyAssistantContact: () => ({ loading: false, agentId: null, error: null, provisionDeviceId: null, contact: null, homeDeviceId: null }),
}))
vi.mock('../../../apps/desktop/src/components/assistant/useAssistantDm', () => ({
  useAssistantDm: () => ({ chatId: null, failed: false, retry: () => {} }),
}))

const { usePhoneAssistant } = await import('../../../apps/desktop/src/mobile/assistant/usePhoneAssistant')

function Probe() {
  return <span data-testid="stage">{usePhoneAssistant(true).stage.stage}</span>
}

describe('手机「咕咕」那一格:设备列表刷新不让已经知道的事退回「在读」(#7429)', () => {
  let harness: ReturnType<typeof createReactHarness>
  beforeEach(() => {
    harness = createReactHarness()
  })
  afterEach(() => harness.cleanup())
  const stage = () => harness.container.querySelector('[data-testid="stage"]')?.textContent

  // 没有快照时 stage 才看「管家有没有结论」。共享测试库上的新号平时是引导、刷新时闪 cloud-loading:只能是没有快照、管家说「这里没开放」(available=false)。
  it('管家已经说过「这里没开放」:设备列表刷新的那一下仍是开通引导', async () => {
    store.devices = { loading: false, cloudComputer: { available: false, snapshot: null, loadError: null } }
    await harness.render(<Probe />)
    expect(stage()).toBe('onboarding')
    store.devices = { ...store.devices, loading: true }
    await act(async () => harness.render(<Probe />))
    expect(stage(), 'refreshing the device list').toBe('onboarding')
    store.devices = { ...store.devices, loading: false }
    await harness.render(<Probe />)
    expect(stage()).toBe('onboarding')
  })

  it('第一次进来、管家还没回话:是「在读」,不是开通引导', async () => {
    store.devices = { loading: false, cloudComputer: { available: true, snapshot: null, loadError: null } }
    await harness.render(<Probe />)
    expect(stage()).toBe('cloud-loading')
  })
})
