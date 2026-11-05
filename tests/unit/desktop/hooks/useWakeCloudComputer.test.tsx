// @vitest-environment jsdom
// #7199 手机上打开云电脑上的会话 / 在它上面新建:睡着就叫醒它,每打开一次只叫一次。设备表里的「醒着」可能还是睡下之前的
// (验收 10-15:睡下后库里那一行两分钟才翻离线)⇒ 醒着也现问一次管家,真睡着了再叫;问不到 ❌ 说「没能唤醒」。
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CloudComputerSnapshot } from '@gugu/core/cloud/cloudComputer'
import type { Device } from '@gugu/core/shared/types/chat'
import { createReactHarness } from '../../../support/testHarness'

const store = vi.hoisted(() => ({
  refreshCloudComputer: vi.fn<() => Promise<unknown>>(),
  wakeCloudComputer: vi.fn<() => Promise<void>>(),
}))
vi.mock('../../../../apps/desktop/src/lib/cloudComputerStore', () => store)
vi.mock('../../../../apps/desktop/src/lib/log', () => ({ rendererLogger: () => ({ warn: () => {}, info: () => {}, error: () => {} }) }))

const { useCloudComputerWake: useWakeForIssue } = await import('../../../../apps/desktop/src/hooks/useWakeCloudComputer')

type Target = Pick<Device, 'device_id' | 'cloud_computer'>
let issue: ReturnType<typeof useWakeForIssue>['issue'] = null
function Probe({ device }: { device: Target | null }) {
  issue = useWakeForIssue(device).issue
  return null
}
const snap = (state: CloudComputerSnapshot['state']): CloudComputerSnapshot => ({ state, deviceId: 'cloud', error: null, since: null })

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  harness = createReactHarness()
  issue = null
  store.refreshCloudComputer.mockReset()
  store.wakeCloudComputer.mockReset().mockResolvedValue(undefined)
})
afterEach(() => harness.cleanup())

const open = (device: Target | null) => harness.render(createElement(Probe, { device }))
const settle = () => act(async () => {})

describe('useCloudComputerWake: issue', () => {
  it('睡着:打开就叫醒,开着时 ❌ 再叫', async () => {
    await open({ device_id: 'cloud', cloud_computer: 'asleep' })
    await open({ device_id: 'cloud', cloud_computer: 'asleep' })
    expect(store.wakeCloudComputer).toHaveBeenCalledTimes(1)
    expect(store.refreshCloudComputer).not.toHaveBeenCalled()
  })

  it('设备表说醒着、管家说其实睡着了:叫醒它', async () => {
    store.refreshCloudComputer.mockResolvedValue(snap('asleep'))
    await open({ device_id: 'cloud', cloud_computer: 'awake' })
    await settle()
    expect(store.wakeCloudComputer).toHaveBeenCalledTimes(1)
  })

  it('真醒着:只问一下,❌ 叫醒;问不到也 ❌ 说「没能唤醒」', async () => {
    store.refreshCloudComputer.mockResolvedValue(snap('awake'))
    await open({ device_id: 'cloud', cloud_computer: 'awake' })
    await settle()
    expect(store.wakeCloudComputer).not.toHaveBeenCalled()

    store.refreshCloudComputer.mockRejectedValue(new Error('offline'))
    await open({ device_id: 'cloud-2', cloud_computer: 'awake' })
    await settle()
    expect(store.wakeCloudComputer).not.toHaveBeenCalled()
    expect(issue).toBeNull()
  })

  it('不是云电脑 / 正在醒:❌ 问、❌ 叫', async () => {
    await open({ device_id: 'box', cloud_computer: undefined })
    await open({ device_id: 'cloud', cloud_computer: 'waking' })
    await settle()
    expect(store.refreshCloudComputer).not.toHaveBeenCalled()
    expect(store.wakeCloudComputer).not.toHaveBeenCalled()
  })

  it('叫醒没成:交出是哪一类', async () => {
    const { CloudComputerError } = await import('@gugu/core/cloud/cloudComputer')
    store.wakeCloudComputer.mockRejectedValue(new CloudComputerError(403, 'credits_exhausted', 'no credits'))
    await open({ device_id: 'cloud', cloud_computer: 'asleep' })
    await settle()
    expect(issue).toEqual({ kind: 'credits_exhausted' })
  })
})

// 产品入口(main.tsx)包着 React.StrictMode:开发模式下 effect 会 setup → cleanup → setup。挂着的标记要在第二次 setup
// 里回到「挂着」,否则叫醒没成的原因与「还在叫」都再也落不到页面上(一直转、也没有重试)。
const { useCloudComputerWake } = await import('../../../../apps/desktop/src/hooks/useWakeCloudComputer')
let wake: ReturnType<typeof useCloudComputerWake> | null = null
function RetryProbe({ device }: { device: Target | null }) {
  wake = useCloudComputerWake(device)
  return null
}

describe('useCloudComputerWake under StrictMode', () => {
  it('叫醒没成:交出原因;点重试再叫一次,成了原因清掉', async () => {
    const { StrictMode } = await import('react')
    const { CloudComputerError } = await import('@gugu/core/cloud/cloudComputer')
    store.wakeCloudComputer.mockRejectedValueOnce(new CloudComputerError(403, 'credits_exhausted', 'no credits'))
    await harness.render(createElement(StrictMode, null, createElement(RetryProbe, { device: { device_id: 'cloud', cloud_computer: 'asleep' } })))
    await settle()
    expect(store.wakeCloudComputer).toHaveBeenCalledTimes(1)
    expect(wake?.issue).toEqual({ kind: 'credits_exhausted' })
    expect(wake?.dropped).toBe(false)
    await act(async () => { wake!.retry() })
    await settle()
    expect(store.wakeCloudComputer).toHaveBeenCalledTimes(2)
    expect(wake?.issue).toBeNull()
    // 重试成了、管家那一格还没翻过来(仍是 asleep):❌ 说「连接断了」
    expect(wake?.dropped).toBe(false)
  })
})

describe('useCloudComputerWake: dropped', () => {
  const render = (cloud: Target['cloud_computer']) => harness.render(createElement(RetryProbe, { device: { device_id: 'cloud', cloud_computer: cloud } }))

  it('叫醒成了、还没看到它起来:不算断;看到它起来又收回:算断,且 ❌ 自己再叫', async () => {
    await render('asleep')
    await settle()
    expect(store.wakeCloudComputer).toHaveBeenCalledTimes(1)
    expect(wake?.dropped).toBe(false)
    await render('waking')
    await settle()
    await render('awake')
    await settle()
    expect(wake?.dropped).toBe(false)
    await render('asleep')
    await settle()
    expect(wake?.dropped).toBe(true)
    expect(store.wakeCloudComputer).toHaveBeenCalledTimes(1)
  })
})
