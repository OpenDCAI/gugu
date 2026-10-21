// @vitest-environment jsdom
// #7249 设置回到最左栏栏底(owner 10-15:「用设置其实挺频繁的……而不是藏在这个用户头像里面」):
// 一枚齿轮,一点就开设置;设置开着时它亮着;owner 10-16 移除了账户按钮及其菜单。
import { describe, expect, it, vi } from 'vitest'
import { Sidebar } from '../../../../apps/desktop/src/components/Sidebar'
import { AUTOMATION_TEST_IDS } from '../../../../apps/desktop/src/lib/automationDom'
import { clickElement, createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'

const auth = { id: 'u1', email: 'u@e.com', nickname: 'U' }
const byTestId = (root: ParentNode, id: string) => root.querySelector<HTMLElement>(`[data-testid="${id}"]`)

async function renderSidebar(props: Record<string, unknown>) {
  const harness = createReactHarness()
  await renderWithAppProviders(harness, createNode(Sidebar, { activeTab: 'chats', onTabChange: vi.fn(), ...props }), { auth })
  return harness
}

describe('#7249 最左栏的设置齿轮', () => {
  it('点齿轮直接打开设置(与原来头像菜单「设置」同一个入口)', async () => {
    const onTabChange = vi.fn()
    const harness = await renderSidebar({ onTabChange })
    try {
      const gear = byTestId(harness.container, AUTOMATION_TEST_IDS.sidebarSettingsNav)
      expect(gear, '栏上应有设置齿轮').not.toBeNull()
      expect(gear!.getAttribute('aria-label')).toBe('设置')
      // 在栏底:排在功能导航那一组之后,不在里面。
      expect(gear!.closest('.gg-sidebar-nav')).toBeNull()
      await clickElement(gear!)
      expect(onTabChange).toHaveBeenCalledWith('settings')
    } finally {
      harness.cleanup()
    }
  })

  it('设置开着时齿轮是选中态,关着时不是', async () => {
    const open = await renderSidebar({ settingsOpen: true })
    try {
      const gear = byTestId(open.container, AUTOMATION_TEST_IDS.sidebarSettingsNav)!
      expect(gear.hasAttribute('data-on')).toBe(true)
      expect(gear.getAttribute('aria-current')).toBe('page')
    } finally {
      open.cleanup()
    }
    const closed = await renderSidebar({ settingsOpen: false })
    try {
      const gear = byTestId(closed.container, AUTOMATION_TEST_IDS.sidebarSettingsNav)!
      expect(gear.hasAttribute('data-on')).toBe(false)
      expect(gear.getAttribute('aria-current')).toBeNull()
    } finally {
      closed.cleanup()
    }
  })

  it('栏底只有设置齿轮,没有账户按钮或账户菜单', async () => {
    const harness = await renderSidebar({})
    try {
      expect(byTestId(harness.container, AUTOMATION_TEST_IDS.sidebarProfileButton)).toBeNull()
      expect(byTestId(document.body, AUTOMATION_TEST_IDS.sidebarProfileMenu)).toBeNull()
      const buttons = harness.container.querySelectorAll('.gg-sidebar-bottom button')
      expect(buttons).toHaveLength(1)
      expect(buttons[0]).toBe(byTestId(harness.container, AUTOMATION_TEST_IDS.sidebarSettingsNav))
    } finally {
      harness.cleanup()
    }
  })
})
