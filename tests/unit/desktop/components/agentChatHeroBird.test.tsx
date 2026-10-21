// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'
import { runtime } from '../../../../apps/desktop/src/components/agentAvatar/engine/runtime'
import { AgentChatHero } from '../../../../apps/desktop/src/components/chat/AgentChatHero'
import { AGENT_HERO_OVERHANG_PX, isAgentHeroBird } from '../../../../apps/desktop/src/components/chat/chatPresentation'

// 单聊头栏上放大 + 上移 + 探出的只能是小鸟:传了照片的 agent 是一张圆图,没有小鸟头顶那圈留白,
// 套同一套几何会把脸顶出窗格(窗格根节点 overflow:hidden)被裁、右上角状态角标也被吃掉(#7161 review)。
const LOOK_URL = 'https://cdn.example.com/avatars/agent-look/v1/cream.webp?rest=happy'
const PHOTO_URL = 'https://cdn.example.com/avatars/u/agent-1.png'

describe('isAgentHeroBird', () => {
  it('没传头像 / 头像是「形象」地址 = 小鸟', () => {
    expect(isAgentHeroBird(null)).toBe(true)
    expect(isAgentHeroBird(undefined)).toBe(true)
    expect(isAgentHeroBird(LOOK_URL)).toBe(true)
  })

  it('传了照片(哪怕坏了 / 是空串)= 不是小鸟,❌ 不套小鸟的几何', () => {
    expect(isAgentHeroBird(PHOTO_URL)).toBe(false)
    expect(isAgentHeroBird('')).toBe(false)
    expect(isAgentHeroBird('undefined')).toBe(false)
  })

  it('探出的让位量是正数 —— 小鸟身体底边确实在头栏下面', () => {
    expect(AGENT_HERO_OVERHANG_PX).toBeGreaterThan(0)
  })
})

describe('AgentChatHero 的小鸟 / 照片两条路', () => {
  let harness: ReturnType<typeof createReactHarness>

  beforeEach(() => {
    harness = createReactHarness()
    vi.spyOn(runtime, 'register').mockImplementation(
      () =>
        ({
          engine: { crop: 'full', gain: 1, rotate: true, setState() {}, setExpression() {}, setBodyColor() {}, poke() {}, hop() {} },
          outfit: { set() {} },
          opts: {},
        }) as never
    )
  })
  afterEach(() => {
    harness.cleanup()
    vi.restoreAllMocks()
  })

  const props = { agentId: 'agent-1', name: 'A', presentation: null, status: null, onOpen: () => {} }
  const avatarButton = () => harness.container.querySelector<HTMLElement>('.gg-agent-hero-avatar')!

  it('小鸟:桌面画布 80、带小鸟标记(CSS 靠它上移);手机 56,正好装进 56px 的头栏', async () => {
    await renderWithAppProviders(harness, createNode(AgentChatHero, { ...props, avatarUrl: null, mobile: false }))
    expect(avatarButton().hasAttribute('data-hero-bird')).toBe(true)
    expect(harness.container.querySelector<HTMLCanvasElement>('canvas[data-agent-avatar]')!.style.width).toBe('80px')

    await renderWithAppProviders(harness, createNode(AgentChatHero, { ...props, avatarUrl: LOOK_URL, mobile: true }))
    expect(avatarButton().hasAttribute('data-hero-bird')).toBe(true)
    expect(harness.container.querySelector<HTMLCanvasElement>('canvas[data-agent-avatar]')!.style.width).toBe('56px')
  })

  it('照片:没有小鸟标记(不上移不探出),保持放大之前的 56 / 40,不挂悬停反应', async () => {
    await renderWithAppProviders(harness, createNode(AgentChatHero, { ...props, avatarUrl: PHOTO_URL, mobile: false }))
    expect(avatarButton().hasAttribute('data-hero-bird')).toBe(false)
    expect(harness.container.querySelector('canvas[data-agent-avatar]')).toBeNull()
    expect(harness.container.querySelector<HTMLImageElement>('.gg-agent-hero-avatar img')!.style.width).toBe('56px')

    await renderWithAppProviders(harness, createNode(AgentChatHero, { ...props, avatarUrl: PHOTO_URL, mobile: true }))
    expect(harness.container.querySelector<HTMLImageElement>('.gg-agent-hero-avatar img')!.style.width).toBe('40px')
  })
})
