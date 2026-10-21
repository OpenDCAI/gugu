// @vitest-environment jsdom
// owner 10-16「替换掉这个人物头像,用咕咕,并且得考虑最开始没有创建咕咕的时候新用户,这里的按钮是什么样」:
// 最左栏顶格 = 咕咕;栏底只留设置齿轮;还没有咕咕的新用户这一格照样在(淡 + 「+」,提示领取 / 创建)。
import { createElement, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AUTOMATION_TEST_IDS } from '../../../../apps/desktop/src/lib/automationDom'
import { clickElement, createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'

const capability = vi.hoisted(() => ({ agentRuntime: true }))
vi.mock('../../../../apps/desktop/src/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../apps/desktop/src/platform')>()
  return { ...actual, platform: { ...actual.platform, capabilities: { ...actual.platform.capabilities, get agentRuntime() { return capability.agentRuntime } } } }
})

type Mine = { contact: { id: string; display_name: string; avatar: string | null } | null; agentId: string | null; loading: boolean; error: string | null }
const mine = vi.hoisted(() => ({ value: { contact: null, agentId: null, loading: false, error: null } as Mine }))
vi.mock('../../../../apps/desktop/src/lib/myAssistant', () => ({ useMyAssistantContact: () => mine.value }))

const bridge = vi.hoisted(() => ({ snapshot: null as unknown }))
vi.mock('../../../../apps/desktop/src/lib/assistantShellBridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../apps/desktop/src/lib/assistantShellBridge')>()
  return {
    ...actual,
    readAssistantShellBridge: () => ({
      getSnapshot: () => bridge.snapshot,
      subscribe: () => () => undefined,
      subscribeVoiceNoteHandler: () => () => undefined,
      getVoiceNoteHandler: () => null,
    }),
  }
})

const { Sidebar } = await import('../../../../apps/desktop/src/components/Sidebar')
const { DevicesContext } = await import('../../../../apps/desktop/src/store/devicesContext')

const auth = { id: 'u1', email: 'u@e.com', nickname: 'U' }
const byTestId = (root: ParentNode, id: string) => root.querySelector<HTMLElement>(`[data-testid="${id}"]`)

type Cloud = { available: boolean; snapshot: { state: string; deviceId: string | null; error: null; since: null } | null; loadError: string | null }
async function renderRail(cloud: Cloud, onTabChange = vi.fn()) {
  const harness = createReactHarness()
  const value = {
    devices: [], loading: false, error: null, refresh: async () => {}, rename: async () => {}, remove: async () => {},
    listBoundAgents: async () => [], cloudComputer: cloud,
  }
  const node: ReactNode = createElement(DevicesContext.Provider, { value: value as never }, createNode(Sidebar, { activeTab: 'chats', onTabChange }))
  await renderWithAppProviders(harness, node, { auth })
  return harness
}

afterEach(() => {
  capability.agentRuntime = true
  mine.value = { contact: null, agentId: null, loading: false, error: null }
  bridge.snapshot = null
})

describe('最左栏顶格 = 咕咕', () => {
  it('网页版没有本机 Agent runtime 也能打开云端助理入口', async () => {
    capability.agentRuntime = false
    bridge.snapshot = { member: true }
    const onTabChange = vi.fn()
    const harness = await renderRail({ available: true, snapshot: { state: 'none', deviceId: null, error: null, since: null }, loadError: null }, onTabChange)
    try {
      const top = byTestId(harness.container, AUTOMATION_TEST_IDS.sidebarAssistantNav)
      expect(top).not.toBeNull()
      await clickElement(top!)
      expect(onTabChange).toHaveBeenCalledWith('tasks')
    } finally { harness.cleanup() }
  })

  it('有咕咕:顶格是它的头像;栏底只留设置齿轮;功能导航里没有第二个咕咕', async () => {
    mine.value = { contact: { id: 'a1', display_name: '小咕', avatar: null }, agentId: 'a1', loading: false, error: null }
    const onTabChange = vi.fn()
    const harness = await renderRail({ available: true, snapshot: { state: 'awake', deviceId: 'd1', error: null, since: null }, loadError: null }, onTabChange)
    try {
      const top = byTestId(harness.container, AUTOMATION_TEST_IDS.sidebarAssistantNav)!
      const profile = byTestId(harness.container, AUTOMATION_TEST_IDS.sidebarProfileButton)
      const gear = byTestId(harness.container, AUTOMATION_TEST_IDS.sidebarSettingsNav)!
      expect(top.getAttribute('data-entry')).toBe('found')
      expect(top.getAttribute('aria-label')).toBe('小咕')
      // 顶格不在功能导航里;栏底只有齿轮,没有账户按钮。
      expect(top.closest('.gg-sidebar-nav')).toBeNull()
      expect(harness.container.querySelectorAll(`[data-testid="${AUTOMATION_TEST_IDS.sidebarAssistantNav}"]`)).toHaveLength(1)
      expect(profile).toBeNull()
      expect(gear.closest('.gg-sidebar-bottom')).not.toBeNull()
      // 顶格排在整条栏最前面。
      const all = [...harness.container.querySelectorAll<HTMLElement>('button')]
      expect(all[0]).toBe(top)
      await clickElement(top)
      expect(onTabChange).toHaveBeenCalledWith('tasks')
    } finally {
      harness.cleanup()
    }
  })

  it('还没有咕咕的新用户:这一格照样在,淡一点 + 「+」;会员说「领取」,非会员说「创建」,没读到会员状态不写会员相关', async () => {
    const cloud: Cloud = { available: true, snapshot: { state: 'none', deviceId: null, error: null, since: null }, loadError: null }
    for (const [member, label] of [[true, '领取你的咕咕'], [false, '创建你的咕咕'], [null, '开通你的咕咕']] as const) {
      bridge.snapshot = { member }
      const harness = await renderRail(cloud)
      try {
        const top = byTestId(harness.container, AUTOMATION_TEST_IDS.sidebarAssistantNav)!
        expect(top.getAttribute('data-entry')).toBe('none')
        expect(top.getAttribute('aria-label')).toBe(label)
        expect(top.querySelector('.gg-sidebar-assistant-mark')).not.toBeNull()
        expect(top.querySelector('.gg-sidebar-assistant-face')?.hasAttribute('data-dim')).toBe(true)
      } finally {
        harness.cleanup()
      }
    }
  })

  it('正在准备使用品牌加载动画,读不到它是谁如实说读不到(❌ 当成没有)', async () => {
    bridge.snapshot = { preparing: true }
    const preparing = await renderRail({ available: true, snapshot: { state: 'provisioning', deviceId: null, error: null, since: null }, loadError: null })
    try {
      const top = byTestId(preparing.container, AUTOMATION_TEST_IDS.sidebarAssistantNav)!
      expect(top.getAttribute('data-entry')).toBe('preparing')
      expect(top.querySelector('[data-gg-loading="inline"]')).not.toBeNull()
      expect(top.querySelector('.gg-sidebar-assistant-spinner')).toBeNull()
      expect(top.querySelector('canvas')).toBeNull()
      expect(top.querySelector('.gg-sidebar-assistant-mark')).toBeNull()
    } finally {
      preparing.cleanup()
    }
    bridge.snapshot = null
    mine.value = { contact: null, agentId: null, loading: false, error: 'boom' }
    const unreadable = await renderRail({ available: true, snapshot: { state: 'awake', deviceId: 'd1', error: null, since: null }, loadError: null })
    try {
      const top = byTestId(unreadable.container, AUTOMATION_TEST_IDS.sidebarAssistantNav)!
      expect(top.getAttribute('data-entry')).toBe('unreadable')
      expect(top.getAttribute('aria-label')).toContain('读不到')
    } finally {
      unreadable.cleanup()
    }
  })

  it('管家说这里没开放云电脑:这一格照样在(非会员装在这台电脑上,owner 10-16),❌ 藏起来', async () => {
    const harness = await renderRail({ available: false, snapshot: null, loadError: null })
    try {
      const top = byTestId(harness.container, AUTOMATION_TEST_IDS.sidebarAssistantNav)!
      expect(top.getAttribute('data-entry')).toBe('none')
      expect(byTestId(harness.container, AUTOMATION_TEST_IDS.sidebarProfileButton)).toBeNull()
    } finally {
      harness.cleanup()
    }
  })
})
