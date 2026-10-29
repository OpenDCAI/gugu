// @vitest-environment jsdom
//
// 「在本群打开」的常驻入口:卡片划走以后,页头 ⋯ 列出这台设备上装着、开着、有自己页面的 App,点一下走卡片「打开」的同一条
// `openApp`,在本对话的右栏打开它自己的页(海龟汤 / 读论文车道 10-19)。
import { createRef } from 'react'
import { runInAction } from 'mobx'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clickElement, createNode, createReactHarness, renderWithAppProviders } from '../../../../support/testHarness'
import { ChatHeaderActions } from '../../../../../apps/desktop/src/components/chat/ChatHeaderActions'
import { installedExtensionsStore } from '../../../../../apps/desktop/src/session/renderer/features/extensions/installed-extensions-store'
import { EXTENSION_API_VERSION, parseExtensionManifest } from '../../../../../apps/desktop/src/session/shared/extensions/manifest'
import { UI_EVENTS } from '../../../../../apps/desktop/src/lib/uiEvents'

const app = (id: string, name: string, tab: Record<string, unknown>) =>
  parseExtensionManifest({ id, name, version: '1.0.0', apiVersion: EXTENSION_API_VERSION, entry: 'index.html', contributes: { tabs: [{ name: 'main', title: name, ...tab }] } })

vi.mock('@/lib/chatAppPins', () => ({ readChatAppPins: async () => [], setChatAppPin: async () => [], watchChatAppPins: () => () => {} }))
vi.mock('@/lib/chatTopicPins', () => ({ readChatTopicPins: async () => [], setChatTopicPin: async () => [], watchChatTopicPins: () => () => {} }))

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  harness = createReactHarness()
  runInAction(() => {
    installedExtensionsStore.manifests = [
      app('turtle-soup', '海龟汤', {}),
      app('paper-reader', '读论文', {}),
      app('draw-guess', '你画我猜', { opensFiles: { chat: ['.draw-guess.json'] } }),
    ]
    installedExtensionsStore.disabled = ['paper-reader']
  })
})
afterEach(() => {
  harness.cleanup()
  runInAction(() => {
    installedExtensionsStore.manifests = []
    installedExtensionsStore.disabled = []
  })
})

async function openMenu(mobile: boolean) {
  await renderWithAppProviders(harness, createNode(ChatHeaderActions, {
    isGroupChat: true,
    isRoomChat: true,
    searchMode: false,
    folderShown: false,
    infoShown: false,
    showHeaderMenu: true,
    mobile,
    moreButtonRef: createRef<HTMLButtonElement>(),
    onEnterSearchMode: vi.fn(),
    onOpenFolder: vi.fn(),
    onCloseWorkspacePanel: vi.fn(),
    onOpenInfo: vi.fn(),
    onCloseInfo: vi.fn(),
    onToggleHeaderMenu: vi.fn(),
    onCloseHeaderMenu: vi.fn(),
  }), { chat: { activeChatId: 'g', chats: [{ id: 'g', kind: 'group' }] as never } })
  const entry = mobile
    ? [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.textContent === '群 Apps')!
    : document.querySelector<HTMLElement>('button[aria-label="群 Apps"]')!
  await clickElement(entry)
  return Array.from(document.querySelectorAll<HTMLElement>('[data-testid="group-apps-open"]'))
}

describe('群 Apps 打开本机的 App', () => {
  for (const mobile of [false, true]) {
    it(`${mobile ? '手机' : '桌面'}:只列开着、有自己页面的 App;点一下 = openApp(它, 本对话)`, async () => {
      const rows = await openMenu(mobile)
      // 停用的(读论文)与只为文件打开的(你画我猜)不列。
      expect(rows.map((row) => row.querySelector('span.truncate')?.textContent)).toEqual(['海龟汤'])
      const asked = vi.fn()
      const listen = (event: Event) => asked((event as CustomEvent).detail)
      window.addEventListener(UI_EVENTS.openApp, listen)
      try {
        await clickElement(rows[0]!)
      } finally {
        window.removeEventListener(UI_EVENTS.openApp, listen)
      }
      expect(asked).toHaveBeenCalledWith({ extensionId: 'turtle-soup', chatId: 'g' })
    })
  }

  it('没有可打开的 App:群 Apps 列表为空', async () => {
    runInAction(() => { installedExtensionsStore.disabled = ['turtle-soup', 'paper-reader'] })
    expect(await openMenu(false)).toEqual([])
  })
})
