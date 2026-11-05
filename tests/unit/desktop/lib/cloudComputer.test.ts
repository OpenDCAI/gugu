// #7199 云电脑在设备列表里:哪一行是它(只认管家给的 deviceId)、此刻什么样、开通进度三步怎么打勾、
// 什么时候要每 3 秒 / 每 30 秒问一次管家,以及「休眠中 ≠ 离线」在排序、可选、行模型上的样子。
import { describe, expect, it } from 'vitest'
import type { CloudComputerSnapshot } from '@gugu/core/cloud/cloudComputer'
import type { Device } from '@gugu/core/shared/types/chat'
import {
  CLOUD_COMPUTER_FAST_POLL_MS,
  CLOUD_COMPUTER_WATCH_MS,
  cloudComputerPollMs,
  cloudComputerWatchMs,
  cloudComputerProvisionSteps,
  deviceNeedsWake,
  withCloudComputerPresence,
} from '@/lib/cloudComputerStore'
import { deviceRowModel } from '@/lib/deviceRowModel'
import { isDeviceSelectable, sortDevices } from '@/lib/devicesSort'

function device(id: string, over: Partial<Device> = {}): Device {
  return {
    device_id: id,
    label: id,
    hostname: id,
    platform: 'linux',
    status: 'offline',
    last_seen_at: '2026-10-15T00:00:00Z',
    is_online: false,
    capabilities: { terminals: [], runtimes: [], host_kind: 'server' },
    ...over,
  }
}

const snap = (over: Partial<CloudComputerSnapshot>): CloudComputerSnapshot => ({
  state: 'asleep',
  deviceId: 'cloud',
  error: null,
  since: null,
  ...over,
})

describe('withCloudComputerPresence', () => {
  it('只给管家说的那一行补上样子,别的行原样(同一个对象)', () => {
    const other = device('box', { is_online: true })
    const rows = withCloudComputerPresence([other, device('cloud')], snap({ state: 'asleep' }))
    expect(rows[0]).toBe(other)
    expect(rows[1]!.cloud_computer).toBe('asleep')
  })

  it('醒了、server 还没上线 = 正在唤醒;上线了 = 运行中', () => {
    expect(withCloudComputerPresence([device('cloud')], snap({ state: 'awake' }))[0]!.cloud_computer).toBe('waking')
    expect(withCloudComputerPresence([device('cloud', { is_online: true })], snap({ state: 'awake' }))[0]!.cloud_computer).toBe('awake')
  })

  it('没有云电脑 / 还没问到:列表原样返回', () => {
    const rows = [device('cloud')]
    expect(withCloudComputerPresence(rows, null)).toBe(rows)
    expect(withCloudComputerPresence(rows, snap({ state: 'none', deviceId: null }))).toBe(rows)
  })

  it('不再是云电脑(管家那边关掉了):去掉那一格', () => {
    const rows = withCloudComputerPresence([device('cloud', { cloud_computer: 'asleep' })], snap({ state: 'provisioning' }))
    expect(rows[0]).not.toHaveProperty('cloud_computer')
  })
})

describe('cloudComputerPollMs', () => {
  it('开通中、正在醒:每 3 秒问一次', () => {
    expect(cloudComputerPollMs(snap({ state: 'provisioning', deviceId: null }), [])).toBe(CLOUD_COMPUTER_FAST_POLL_MS)
    expect(cloudComputerPollMs(snap({ state: 'waking' }), [])).toBe(CLOUD_COMPUTER_FAST_POLL_MS)
  })
  it('管家说醒了、那一行还没在线:接着问;在线了就停', () => {
    expect(cloudComputerPollMs(snap({ state: 'awake' }), [device('cloud')])).toBe(CLOUD_COMPUTER_FAST_POLL_MS)
    expect(cloudComputerPollMs(snap({ state: 'awake' }), [device('cloud', { is_online: true })])).toBeNull()
  })
  it('睡着 / 没有 / 出错 / 还没问到:不轮询', () => {
    expect(cloudComputerPollMs(snap({ state: 'asleep' }), [])).toBeNull()
    expect(cloudComputerPollMs(snap({ state: 'none', deviceId: null }), [])).toBeNull()
    expect(cloudComputerPollMs(snap({ state: 'error', error: 'x' }), [])).toBeNull()
    expect(cloudComputerPollMs(null, [])).toBeNull()
  })
})

describe('cloudComputerWatchMs', () => {
  // 验收 10-15:07:18:24 睡下,库里那一行 07:20:27 才翻离线,这两分钟里私聊不说「休眠中」、点会话不先叫醒。
  it('有云电脑(醒着 / 睡着):每 30 秒问一次 —— 它睡下、被别处叫醒,❌ 等库里那一行心跳超时', () => {
    expect(cloudComputerWatchMs(snap({ state: 'awake' }))).toBe(CLOUD_COMPUTER_WATCH_MS)
    expect(cloudComputerWatchMs(snap({ state: 'asleep' }))).toBe(CLOUD_COMPUTER_WATCH_MS)
  })
  it('没有 / 开通中还没设备行 / 出错 / 还没问到:❌ 白问(途中由每 3 秒那一档管)', () => {
    expect(cloudComputerWatchMs(snap({ state: 'none', deviceId: null }))).toBeNull()
    expect(cloudComputerWatchMs(snap({ state: 'provisioning', deviceId: null }))).toBeNull()
    expect(cloudComputerWatchMs(snap({ state: 'error', error: 'x' }))).toBeNull()
    expect(cloudComputerWatchMs(null)).toBeNull()
  })
})

describe('cloudComputerProvisionSteps', () => {
  const statuses = (s: CloudComputerSnapshot, d: Pick<Device, 'is_online'> | null) =>
    cloudComputerProvisionSteps(s, d).map((step) => `${step.id}:${step.status}`)

  it('还没登上账号:第一步在跑,后两步等着', () => {
    expect(statuses(snap({ state: 'provisioning', deviceId: null }), null)).toEqual(['machine:running', 'online:pending', 'assistant:pending'])
  })
  it('设备行出现了、还没在线:第二步在跑', () => {
    expect(statuses(snap({ state: 'provisioning' }), { is_online: false })).toEqual(['machine:done', 'online:running', 'assistant:pending'])
  })
  it('上线了、管家还在建助理:第三步在跑', () => {
    expect(statuses(snap({ state: 'provisioning' }), { is_online: true })).toEqual(['machine:done', 'online:done', 'assistant:running'])
  })
  it('awake 且在线:三步都打勾', () => {
    expect(statuses(snap({ state: 'awake' }), { is_online: true })).toEqual(['machine:done', 'online:done', 'assistant:done'])
  })
})

describe('休眠中 ≠ 离线', () => {
  it('行模型:云电脑单独一类(❌ 归进旧咕咕云),版本照 server 说,不标连法', () => {
    const cloud = device('cloud', { cloud_computer: 'asleep', capabilities: { terminals: [], runtimes: [], host_kind: 'server', app_version: '0.2.54', connect_via: 'tunnel' } })
    const model = deviceRowModel(cloud, null)
    expect(model.kind).toBe('cloudComputer')
    expect(model.version).toBe('0.2.54')
    // 开通中那一行还没有 cloud_computer:靠管家给的 id 认出来。
    expect(deviceRowModel(device('cloud'), null, 'cloud').kind).toBe('cloudComputer')
    expect(deviceRowModel(device('cloud'), null, 'other').kind).toBe('server')
  })

  it('排序:休眠中的云电脑排在在线那一组;离线的普通机器在后', () => {
    const rows = sortDevices([
      device('a-offline'),
      device('z-cloud', { cloud_computer: 'asleep' }),
      device('m-online', { is_online: true }),
    ])
    expect(rows.map((d) => d.device_id)).toEqual(['m-online', 'z-cloud', 'a-offline'])
  })

  it('可选:休眠中 / 正在唤醒的云电脑能选,离线的普通机器不能', () => {
    expect(isDeviceSelectable(device('cloud', { cloud_computer: 'asleep' }))).toBe(true)
    expect(isDeviceSelectable(device('cloud', { cloud_computer: 'waking' }))).toBe(true)
    expect(isDeviceSelectable(device('box'))).toBe(false)
    expect(deviceNeedsWake(device('cloud', { cloud_computer: 'awake', is_online: true }))).toBe(false)
  })
})

describe('轮询与「正在唤醒」都有时限', () => {
  const NOW = Date.parse('2026-10-15T06:00:00Z')
  const ago = (ms: number) => new Date(NOW - ms).toISOString()

  it('管家说醒了、它两分钟还没上线:不再每 3 秒问,那一行照离线说(❌ 一直「正在唤醒」)', () => {
    const fresh = snap({ state: 'awake', since: ago(30_000) })
    const stale = snap({ state: 'awake', since: ago(180_000) })
    expect(cloudComputerPollMs(fresh, [device('cloud')], NOW)).toBe(CLOUD_COMPUTER_FAST_POLL_MS)
    expect(cloudComputerPollMs(stale, [device('cloud')], NOW)).toBeNull()
    expect(withCloudComputerPresence([device('cloud')], fresh, NOW)[0]?.cloud_computer).toBe('waking')
    expect(withCloudComputerPresence([device('cloud')], stale, NOW)[0]?.cloud_computer).toBeUndefined()
  })

  it('管家卡在「正在醒」太久就停掉快轮询;开通中不设限(第一次开要几分钟)', () => {
    expect(cloudComputerPollMs(snap({ state: 'waking', since: ago(60_000) }), [], NOW)).toBe(CLOUD_COMPUTER_FAST_POLL_MS)
    expect(cloudComputerPollMs(snap({ state: 'waking', since: ago(600_000) }), [], NOW)).toBeNull()
    expect(cloudComputerPollMs(snap({ state: 'provisioning', deviceId: null, since: ago(600_000) }), [], NOW)).toBe(CLOUD_COMPUTER_FAST_POLL_MS)
  })
})
