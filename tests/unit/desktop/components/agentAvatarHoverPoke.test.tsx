// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react'
import { createReactHarness } from '../../../support/testHarness'
import { runtime } from '../../../../apps/desktop/src/components/agentAvatar/engine/runtime'
import { AgentAvatar } from '../../../../apps/desktop/src/components/agentAvatar/AgentAvatar'
import { installAssistantShellBridge, publishAssistantShell, type AssistantShellSnapshot } from '../../../../apps/desktop/src/lib/assistantShellBridge'
import { Avatar } from '../../../../apps/desktop/src/components/Avatar'

// 单聊头栏那只小鸟:鼠标移上去就算跟它互动(拍一拍),有冷却;不开 hoverPoke 的小鸟(列表里几十只)不反应。
let harness: ReturnType<typeof createReactHarness>
let now = 0
let pokes: ReturnType<typeof vi.fn>

beforeEach(() => {
  harness = createReactHarness()
  installAssistantShellBridge()
  publishAssistantShell({ assistant: null } as AssistantShellSnapshot)
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
  publishAssistantShell({ assistant: null } as AssistantShellSnapshot)
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

  it('Avatar keeps hoverPoke for the assistant; ordinary agents and humans have no 3D reaction', async () => {
    await harness.render(createElement(Avatar, { name: 'Agent', seed: 'agent-1', size: 80, isAgent: true, hoverPoke: true }))
    expect(harness.container.querySelector('canvas')).toBeNull()
    await act(async () => publishAssistantShell({ assistant: { id: 'agent-1', display_name: 'Assistant', avatar: null } } as AssistantShellSnapshot))
    await harness.render(createElement(Avatar, { name: 'A', seed: 'agent-1', size: 80, isAgent: true, hoverPoke: true }))
    await enter()
    expect(pokes).toHaveBeenCalledTimes(1)

    await harness.render(createElement(Avatar, { name: 'H', seed: 'human-1', size: 80, isAgent: false, hoverPoke: true }))
    expect(harness.container.querySelector('canvas[data-agent-avatar]')).toBeNull()
  })
})

it('adds transparent wing drawing room without enlarging the avatar layout, and resizes its rectangular bitmap', async () => {
  await harness.render(createElement(AgentAvatar, { id: 'profile-padding-agent', name: 'A', size: 72, canvasPaddingX: 24 }))
  expect(canvas().style.width).toBe('120px')
  expect(canvas().style.height).toBe('72px')
  expect(canvas().style.marginInline).toBe('-24px')
  const dpr = Math.min(2.5, window.devicePixelRatio || 1)
  expect(canvas().width).toBe(Math.round(120 * dpr))
  expect(canvas().height).toBe(Math.round(72 * dpr))
  await harness.render(createElement(AgentAvatar, { id: 'profile-padding-agent', name: 'A', size: 40 }))
  expect(canvas().width).toBe(Math.round(40 * dpr))
  expect(canvas().height).toBe(Math.round(40 * dpr))
  expect(canvas().style.marginInline).toBe('0px')
})
