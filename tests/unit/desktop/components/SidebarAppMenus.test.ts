// @vitest-environment jsdom
// #7050 左栏的两个右键菜单:钉着的 App(没开有「打开」,都有「在新窗口打开」「从左栏移走」,开着的最下面「退出」)、「App」(已装的都列,点一个打开),
// 以及钉着的 App 开着时左边那个小点。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EXTENSION_API_VERSION } from '../../../../apps/desktop/src/session/shared/extensions/manifest'
import { AUTOMATION_TEST_IDS } from '../../../../apps/desktop/src/lib/automationDom'
import { clickElement, createNode, createReactHarness, fireContextMenu, renderWithAppProviders } from '../../../support/testHarness'

// 「App」与钉着的 App 只在桌面端画(agent 跑在桌面里)。
vi.mock('../../../../apps/desktop/src/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../apps/desktop/src/platform')>()
  return { ...actual, platform: { ...actual.platform, capabilities: { ...actual.platform.capabilities, agentRuntime: true } } }
})
const unpinFromDock = vi.hoisted(() => vi.fn(async () => {}))
const quitApp = vi.hoisted(() => vi.fn(async () => {}))
const openAppInWindow = vi.hoisted(() => vi.fn())
vi.mock('../../../../apps/desktop/src/session/renderer/features/extensions/app-dock', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../apps/desktop/src/session/renderer/features/extensions/app-dock')>()),
  unpinFromDock,
  quitApp,
  openAppInWindow,
}))

const { Sidebar } = await import('../../../../apps/desktop/src/components/Sidebar')
const { installedExtensionsStore } = await import('../../../../apps/desktop/src/session/renderer/features/extensions/installed-extensions-store')
const { appState } = await import('../../../../apps/desktop/src/session/renderer/lib/stores/app-state')

const app = (id: string, more: Record<string, unknown> = {}) => ({
  id,
  name: id,
  version: '1.0.0',
  apiVersion: EXTENSION_API_VERSION,
  entry: 'index.html',
  contributes: { tabs: [{ name: 'main', title: id }] },
  ...more,
})

const menuItems = () => Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'))
// 名字那一格(图标位里没图的 App 画它的首字母,不算名字)。
const menuLabels = () => menuItems().map((item) => item.querySelector('.gg-menu-item-label')?.textContent)

describe('#7050 左栏的右键菜单', () => {
  let harness: ReturnType<typeof createReactHarness>
  const onTabChange = vi.fn()

  beforeEach(async () => {
    harness = createReactHarness()
    // timer 有后台(启用即在跑);notes 没有、也没打开过;alpha 装着但没钉。
    installedExtensionsStore.applyList({
      extensions: [app('timer', { background: { entry: 'bg.html' } }), app('notes'), app('alpha')],
      invalid: [],
      icons: {},
      disabled: [],
      disclosure: {},
      dock: ['timer', 'notes'],
    } as never)
    await renderWithAppProviders(
      harness,
      createNode(Sidebar, { activeTab: 'chats', onTabChange }),
      { auth: { id: 'u1', email: 'u@e.com', nickname: 'U' } },
    )
  })

  afterEach(() => {
    harness.cleanup()
    vi.clearAllMocks()
  })

  const dockButton = (id: string) =>
    harness.container.querySelector<HTMLElement>(`[data-dock-app="${id}"] button`)!

  it('开着的 App 左边有小点,没开的没有', () => {
    expect(dockButton('timer').querySelector('.gg-sidebar-running')).not.toBeNull()
    expect(dockButton('notes').querySelector('.gg-sidebar-running')).toBeNull()
  })

  it('右键没开的 App:打开 / 在新窗口打开 / 从左栏移走;点「打开」= 点它的图标', async () => {
    await fireContextMenu(dockButton('notes'))
    expect(menuLabels()).toEqual(['打开', '在新窗口打开', '从左栏移走'])
    expect(dockButton('notes').hasAttribute('data-menu-open')).toBe(true)
    await clickElement(menuItems()[0]!)
    expect(onTabChange).toHaveBeenCalledWith('tasks')
    expect(appState.navigation.currentViewId).toBe('app')
    expect(appState.navigation.viewParamsStore.app?.appId).toBe('notes')
  })

  it('右键开着的 App:没有「打开」;「从左栏移走」只把它从左栏拿走', async () => {
    await fireContextMenu(dockButton('timer'))
    expect(menuLabels()).toEqual(['在新窗口打开', '从左栏移走', '退出'])
    await clickElement(menuItems()[1]!)
    expect(unpinFromDock).toHaveBeenCalledWith('timer')
    expect(quitApp).not.toHaveBeenCalled()
  })

  it('右键「在新窗口打开」= 这个 App 单独成窗(#7052)', async () => {
    await fireContextMenu(dockButton('notes'))
    await clickElement(menuItems()[1]!)
    expect(openAppInWindow).toHaveBeenCalledWith('notes')
  })

  it('右键开着的 App:「退出」隔一道线在最下面,点了就退出它', async () => {
    await fireContextMenu(dockButton('timer'))
    expect(document.body.querySelector('[data-slot="menu-separator"]')).not.toBeNull()
    await clickElement(menuItems()[2]!)
    expect(quitApp).toHaveBeenCalledWith('timer')
    expect(unpinFromDock).not.toHaveBeenCalled()
  })

  it('右键「App」:已装的都列(钉没钉都在),开着的行尾有小点;点一个就打开它', async () => {
    const entry = harness.container.querySelector<HTMLElement>(`[data-testid="${AUTOMATION_TEST_IDS.sidebarAppsNav}"]`)!
    await fireContextMenu(entry)
    expect(menuLabels()).toEqual(['timer', 'notes', 'alpha'])
    expect(menuItems()[0]!.querySelector('.gg-sidebar-launch-running')).not.toBeNull()
    expect(menuItems()[1]!.querySelector('.gg-sidebar-launch-running')).toBeNull()
    await clickElement(menuItems()[2]!)
    expect(onTabChange).toHaveBeenCalledWith('tasks')
    expect(appState.navigation.viewParamsStore.app?.appId).toBe('alpha')
  })
})
