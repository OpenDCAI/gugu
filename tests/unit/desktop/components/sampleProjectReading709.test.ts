// @vitest-environment jsdom
// #709 示例项目那一个键读不到 ≠ 没有:那一行先不出现、屏上那块不收(收了会存进布局),过一会儿再读;
// 示例是屏上唯一一块、被收掉时回首页,❌ 留一屏空白。
import { act } from 'react'
import { runInAction } from 'mobx'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNode, createReactHarness } from '../../../support/testHarness'

const key = vi.hoisted(() => ({
  readSampleProjectShown: vi.fn<(userId: string) => Promise<boolean>>(),
  subscribeSampleProject: vi.fn(() => () => undefined),
}))
vi.mock('../../../../apps/desktop/src/lib/sampleProject', () => key)
vi.mock('../../../../apps/desktop/src/session/renderer/features/assistant/assistant-shell', () => ({
  useAssistantShell: () => ({ ownerId: 'u1', ownerName: 'Ana', ownerAvatar: null }),
}))

const { useSampleProject } = await import('../../../../apps/desktop/src/session/renderer/features/sample-project/use-sample-project')
const { screenLayout } = await import('../../../../apps/desktop/src/session/renderer/app/screen-layout')
const { forgetSampleProjectOnScreen } = await import('../../../../apps/desktop/src/session/renderer/app/screen-layout-actions')
const { appState } = await import('../../../../apps/desktop/src/session/renderer/lib/stores/app-state')

function Probe() {
  const sample = useSampleProject()
  return createNode('output', { 'data-shown': String(sample.shown), 'data-settled': String(sample.settled) })
}

afterEach(() => {
  vi.useRealTimers()
  runInAction(() => {
    screenLayout.layout = null
    screenLayout.blocks.clear()
    screenLayout.parked.clear()
    screenLayout.focusedBlockId = null
    screenLayout.lastSessionBlockId = null
    appState.navigation.viewParamsStore = {}
  })
})

describe('reading whether this account has the sample (#709)', () => {
  it('a failed read leaves it unknown — not settled, so nothing is taken off screen — and reads again later', async () => {
    vi.useFakeTimers()
    key.readSampleProjectShown.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(true)
    const harness = createReactHarness()
    try {
      await harness.render(createNode(Probe))
      await act(async () => { await Promise.resolve() })
      const output = () => harness.container.querySelector('output')!
      expect(output().dataset).toMatchObject({ shown: 'false', settled: 'false' })
      expect(key.readSampleProjectShown).toHaveBeenCalledTimes(1)
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
      expect(key.readSampleProjectShown).toHaveBeenCalledTimes(2)
      expect(output().dataset).toMatchObject({ shown: 'true', settled: 'true' })
    } finally {
      harness.cleanup()
    }
  })
})

describe('taking the sample off screen (#709)', () => {
  it('goes home when it was the only block and there is no session to put back', () => {
    screenLayout.show({ kind: 'sample-project' })
    appState.navigation.navigate('screen')
    forgetSampleProjectOnScreen()
    expect(screenLayout.layout).toBeNull()
    expect(appState.navigation.currentViewId).toBe('home')
  })
})
