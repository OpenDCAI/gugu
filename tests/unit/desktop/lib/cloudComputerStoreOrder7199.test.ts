// #7199 渲染层那一份云电脑状态:几路同时在问管家时只认最晚发出的那一次;换账号作废在途的应答。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CloudComputerSnapshot } from '@gugu/core/cloud/cloudComputer'

const calls: Array<(snapshot: CloudComputerSnapshot) => void> = []
const rejects: Array<(error: unknown) => void> = []
vi.mock('@/lib/cloudComputer', () => ({
  rendererCloudComputerClient: () => ({
    state: () => new Promise<CloudComputerSnapshot>((resolve, reject) => {
      calls.push(resolve)
      rejects.push(reject)
    }),
    provision: async () => {},
    wake: async () => {},
    destroy: async () => {},
  }),
}))
vi.mock('@/lib/log', () => ({ rendererLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }))

const { destroyCloudComputer, getCloudComputerState, refreshCloudComputer, resetCloudComputerState } = await import('@/lib/cloudComputerStore')
const { CloudComputerError } = await import('@gugu/core/cloud/cloudComputer')

const snap = (state: CloudComputerSnapshot['state']): CloudComputerSnapshot => ({ state, deviceId: 'dev-cloud', error: null, since: null })

describe('refreshCloudComputer', () => {
  beforeEach(() => {
    calls.length = 0
    rejects.length = 0
    resetCloudComputerState()
  })

  it('那扇门说「这里没开放」(503 not_open):整块不显示、❌ 报读不到;配上以后问到就出现', async () => {
    const closed = refreshCloudComputer()
    rejects[0]!(new CloudComputerError(503, 'not_open', '云电脑暂未开放'))
    await expect(closed).resolves.toBeNull()
    expect(getCloudComputerState()).toMatchObject({ available: false, snapshot: null, loadError: null })

    const opened = refreshCloudComputer()
    calls[1]!({ ...snap('none'), deviceId: null })
    await opened
    expect(getCloudComputerState()).toMatchObject({ available: true, snapshot: { state: 'none' } })
  })

  it('连不上管家(502)、云端函数没部署(404)照旧报读不到 —— 之前门说过「没开放」也一样', async () => {
    const down = refreshCloudComputer()
    rejects[0]!(new CloudComputerError(404, 'http_404', 'Function not found'))
    await expect(down).rejects.toThrow()
    expect(getCloudComputerState()).toMatchObject({ available: true, loadError: 'failed' })

    const closed = refreshCloudComputer()
    rejects[1]!(new CloudComputerError(503, 'not_open', '云电脑暂未开放'))
    await closed
    const unreachable = refreshCloudComputer()
    rejects[2]!(new CloudComputerError(502, 'unavailable', '云电脑管家暂时连不上'))
    await expect(unreachable).rejects.toThrow()
    expect(getCloudComputerState()).toMatchObject({ available: true, loadError: 'failed' })
  })

  it('先发后到的旧应答 ❌ 盖掉新的', async () => {
    const older = refreshCloudComputer()
    const newer = refreshCloudComputer()
    calls[1]!(snap('awake'))
    await newer
    calls[0]!(snap('asleep'))
    await older
    expect(getCloudComputerState().snapshot?.state).toBe('awake')
  })

  it('换了账号:上一个账号还在路上的应答不落进来', async () => {
    const pending = refreshCloudComputer()
    resetCloudComputerState()
    calls[0]!(snap('asleep'))
    await pending
    expect(getCloudComputerState().snapshot).toBeNull()
  })
})

describe('destroyCloudComputer', () => {
  beforeEach(() => {
    calls.length = 0
    resetCloudComputerState()
  })

  it('关掉成功当场就是「没有」;之后那次 /state 问不到也不回到旧样子', async () => {
    const before = refreshCloudComputer()
    calls[0]!(snap('awake'))
    await before
    const closing = destroyCloudComputer()
    await vi.waitFor(() => expect(getCloudComputerState().snapshot?.state).toBe('none'))
    calls[1]!({ ...snap('none'), deviceId: null })
    await closing
    expect(getCloudComputerState().snapshot).toMatchObject({ state: 'none', deviceId: null })
  })
})
