// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react'
import { createReactHarness } from '../../../support/testHarness'
import { runtime } from '../../../../apps/desktop/src/components/agentAvatar/engine/runtime'
import { AgentAvatar } from '../../../../apps/desktop/src/components/agentAvatar/AgentAvatar'
import { Avatar } from '../../../../apps/desktop/src/components/Avatar'

// 单聊头栏那只小鸟:鼠标移上去就算跟它互动(拍一拍),有冷却;不开 hoverPoke 的小鸟(列表里几十只)不反应。
let harness: ReturnType<typeof createReactHarness>
let now = 0
let pokes: ReturnType<typeof vi.fn>

beforeEach(() => {
  harness = createReactHarness()
  now = 10_000
  pokes = vi.fn()
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.spyOn(runtime, 'register').mockImplementation(
    () =>
      ({
        engine: { crop: 'full', gain: 1, rotate: true, setState() {}, setExpression() {}, setBodyColor() {}, poke: pokes, hop() {} },
        outfit: { set() {} },
        opts: {},
      }) as never
  )
})
afterEach(() => {
  harness.cleanup()
  vi.restoreAllMocks()
})

const canvas = () => harness.container.querySelector<HTMLCanvasElement>('canvas[data-agent-avatar]')!
const enter = async () => {
  await act(async () => {
    // React 的 onPointerEnter 靠 pointerover 合成(原生 pointerenter 不冒泡,React 不听);relatedTarget 空 = 从窗口外进来。
    canvas().dispatchEvent(new MouseEvent('pointerover', { bubbles: true, relatedTarget: null }))
  })
}

describe('悬停拍一拍', () => {
  it('移进来拍一次;冷却内再移进来不重复拍,冷却过了再拍', async () => {
    await harness.render(createElement(AgentAvatar, { id: 'agent-1', name: 'A', size: 80, hoverPoke: true }))
    await enter()
    expect(pokes).toHaveBeenCalledTimes(1)
    now += 600
    await enter()
    expect(pokes, '光标在上面晃一下不该一直抖').toHaveBeenCalledTimes(1)
    now += 1000
    await enter()
    expect(pokes).toHaveBeenCalledTimes(2)
  })

  it('没开 hoverPoke 的(列表、侧栏里的小鸟)移上去不反应', async () => {
    await harness.render(createElement(AgentAvatar, { id: 'agent-1', name: 'A', size: 36 }))
    await enter()
    expect(pokes).not.toHaveBeenCalled()
  })

  it('Avatar 把 hoverPoke 传给小鸟;人 / 照片头像没有这个反应', async () => {
    await harness.render(createElement(Avatar, { name: 'A', seed: 'agent-1', size: 80, isAgent: true, hoverPoke: true }))
    await enter()
    expect(pokes).toHaveBeenCalledTimes(1)

    await harness.render(createElement(Avatar, { name: 'H', seed: 'human-1', size: 80, isAgent: false, hoverPoke: true }))
    expect(harness.container.querySelector('canvas[data-agent-avatar]')).toBeNull()
  })
})
