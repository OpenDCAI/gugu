import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../apps/desktop/src/mobile/agent-watch/sessionpage-rpc', () => ({ machineRpc: vi.fn() }))

const { readinessOf } = await import('../../../apps/desktop/src/mobile/assistant/phoneMachine')

// #7199 手机助理 App 读云电脑之前先说清那台此刻能不能读:睡着要人按「叫醒」(看页面不叫醒),❌ 把睡着说成离线。
describe('readinessOf', () => {
  it('睡着 / 正在醒按云电脑状态说,醒着且在线才读', () => {
    expect(readinessOf({ is_online: false, cloud_computer: 'asleep' })).toBe('asleep')
    expect(readinessOf({ is_online: false, cloud_computer: 'waking' })).toBe('waking')
    expect(readinessOf({ is_online: true, cloud_computer: 'awake' })).toBe('ready')
  })

  it('醒着却不在线、没有这台:连不上', () => {
    expect(readinessOf({ is_online: false, cloud_computer: 'awake' })).toBe('unreachable')
    expect(readinessOf(null)).toBe('unreachable')
  })
})
