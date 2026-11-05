// #7199 叫醒被管家拒了(积分用完 / 会员到期 / 没有权益):管家的 /state 仍是 asleep,渲染层记下是哪台、为什么,
// 那台的设备行不再带 cloud_computer —— 它上面的 agent 照读数说不在线(❌ 当「收回着、有事自己醒」什么都不画)。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CloudComputerSnapshot } from '@gugu/core/cloud/cloudComputer'
import type { Device } from '@gugu/core/shared/types/chat'

let snapshot: CloudComputerSnapshot
let wakeOutcome: () => Promise<void>
vi.mock('@/lib/cloudComputer', () => ({
  rendererCloudComputerClient: () => ({
    state: async () => snapshot,
    provision: async () => {},
    wake: () => wakeOutcome(),
    destroy: async () => {},
  }),
}))
vi.mock('@/lib/log', () => ({ rendererLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }))

const { getCloudComputerState, refreshCloudComputer, resetCloudComputerState, wakeCloudComputer, withCloudComputerPresence } =
  await import('@/lib/cloudComputerStore')
const { CloudComputerError } = await import('@gugu/core/cloud/cloudComputer')

const snap = (state: CloudComputerSnapshot['state']): CloudComputerSnapshot => ({ state, deviceId: 'dev-cloud', error: null, since: null })
const cloudRow = { device_id: 'dev-cloud', is_online: false } as Device
const presenceNow = () => withCloudComputerPresence([cloudRow], getCloudComputerState().snapshot, Date.now(), getCloudComputerState().wakeRefused?.deviceId ?? null)[0]!.cloud_computer

describe('wakeCloudComputer refusal', () => {
  beforeEach(async () => {
    resetCloudComputerState()
    snapshot = snap('asleep')
    wakeOutcome = async () => {}
    await refreshCloudComputer()
  })

  it('收回着、没被拒:设备行说 asleep(画状态前那道映射据此不画)', () => {
    expect(getCloudComputerState().wakeRefused ?? null).toBeNull()
    expect(presenceNow()).toBe('asleep')
  })

  it('积分用完被拒:记下哪台、为什么;那台的设备行不再带 cloud_computer', async () => {
    wakeOutcome = async () => {
      throw new CloudComputerError(403, 'credits_exhausted', '积分用完了')
    }
    await expect(wakeCloudComputer()).rejects.toThrow()
    expect(getCloudComputerState().wakeRefused).toEqual({ deviceId: 'dev-cloud', kind: 'credits_exhausted' })
    expect(presenceNow()).toBeUndefined()
  })

  it('会员到期同样记下', async () => {
    wakeOutcome = async () => {
      throw new CloudComputerError(403, 'membership_expired', '会员到期了')
    }
    await expect(wakeCloudComputer()).rejects.toThrow()
    expect(getCloudComputerState().wakeRefused?.kind).toBe('membership_expired')
  })

  it('不是被拒的失败(管家连不上)不记:仍算收回着', async () => {
    wakeOutcome = async () => {
      throw new CloudComputerError(502, 'unavailable', '云电脑管家暂时连不上')
    }
    await expect(wakeCloudComputer()).rejects.toThrow()
    expect(getCloudComputerState().wakeRefused ?? null).toBeNull()
    expect(presenceNow()).toBe('asleep')
  })

  it('之后叫醒成功、或管家说它离开了 asleep:清掉', async () => {
    wakeOutcome = async () => {
      throw new CloudComputerError(403, 'credits_exhausted', '积分用完了')
    }
    await expect(wakeCloudComputer()).rejects.toThrow()
    wakeOutcome = async () => {}
    await wakeCloudComputer()
    expect(getCloudComputerState().wakeRefused ?? null).toBeNull()

    wakeOutcome = async () => {
      throw new CloudComputerError(403, 'credits_exhausted', '积分用完了')
    }
    await expect(wakeCloudComputer()).rejects.toThrow()
    expect(getCloudComputerState().wakeRefused).not.toBeNull()
    snapshot = snap('waking')
    await refreshCloudComputer()
    expect(getCloudComputerState().wakeRefused ?? null).toBeNull()
  })
})
