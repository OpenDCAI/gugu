// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createReactHarness } from '../../../support/testHarness'
import { folderItem, isFolderItem, WORKSPACE_APP_KIND } from '../../../../apps/desktop/src/session/renderer/features/chats/chat-tabs/chat-panel-item'
import { askChat, chatLayoutOf, openPanelItem, panelFull, panelTabsOf, shownPanelTab, takeChatAsk } from '../../../../apps/desktop/src/session/renderer/features/chats/chat-tabs/chat-layouts'
import { extensionSurfaceStore } from '../../../../apps/desktop/src/session/renderer/features/extensions/extension-surface-store'
import { extensionViewStore, residentPageKey, residentPlace } from '../../../../apps/desktop/src/session/renderer/features/extensions/extension-view-store'
import {
  installedExtensionsStore,
  type InstalledExtensionsList,
} from '../../../../apps/desktop/src/session/renderer/features/extensions/installed-extensions-store'
import { ask, chatTabs, shownItem, type ChatTabsProps } from './chatTabsHarness'

vi.mock('../../../../apps/desktop/src/platform', () => ({
  platform: { kind: 'electron', capabilities: { appUpdates: false, notifications: false, rendererCommandBridge: false } },
}))
// No App runtime under jsdom: this device's Apps answer nothing; the group's shared packages are the test's.
vi.mock('../../../../apps/desktop/src/components/appSlot/appsHere', () => ({
  appsHere: { runs: () => true, grantable: (manifest: unknown) => manifest, installAttachment: vi.fn(), marketOffers: vi.fn(async () => ({ success: true, data: [] })), groupFileOpener: vi.fn(), groupFilesOpenedBy: vi.fn(async () => ({ success: true, data: [] })), appChatFile: vi.fn(), setOpenWithDefault: vi.fn() },
}))
const sharedHere = vi.hoisted(() => ({ packages: new Map<string, unknown>() }))
vi.mock('../../../../apps/desktop/src/components/extensionBundle/sharedPackages', () => ({
  sharedPackagesOf: async () => sharedHere.packages,
  subscribeSharedPackages: () => () => {},
  packageKey: (card: { source: { kind: string; url?: string }; messageId: string }) => (card.source.kind === 'url' ? `url:${card.source.url}` : `msg:${card.messageId}`),
  installPackageOf: (card: { messageId: string }) => ({ messageId: card.messageId }),
}))

/**
 * A group's tabs and the session page's are one model (统筹 110 批的方案 L3-group-panel-fullscreen.md): the same engine, what
 * a page says about itself kept by page in the one store the session page reads, the toolbar and menu read as the session
 * page reads them. Only where each is drawn differs.
 */

let harness: ReturnType<typeof createReactHarness>
const originalCheckVisibility = HTMLElement.prototype.checkVisibility
beforeEach(() => {
  harness = createReactHarness()
  // jsdom has no checkVisibility: an unseen slot claims no page, which is all this file needs of it.
  HTMLElement.prototype.checkVisibility = () => false
})
afterEach(() => {
  harness.cleanup()
  HTMLElement.prototype.checkVisibility = originalCheckVisibility
})

const slot = (props: Partial<ChatTabsProps> = {}) => chatTabs({ chatId: 'group-1', ...props })
const boardPage = () => ({ kind: 'board.main', title: 'Board' })
const fullSwitch = () => harness.container.querySelector<HTMLButtonElement>('[data-testid="group-app-slot-full"]')
const NONE: { id: string; title: string }[] = []

describe('the slot header', () => {
  // owner 10-26 选 A:页签就是标题、× 和「最大化 / 还原」(TabHost.tabFill),页里不再横一行;没有页签条(手机)照旧一个页头。
  it('in a block draws no row of its own; its tab fills the block and back; outside a block no full switch either', async () => {
    const tab = openPanelItem('full-switch', boardPage())!
    await harness.render(slot({ chatId: 'full-switch', tabbed: true }))
    expect(fullSwitch()).toBeNull()
    expect(harness.container.querySelector('[data-testid="group-app-slot-bar"]')).toBeNull()
    const fill = () => chatLayoutOf('full-switch').groups[0]!.pane.tabFill(tab)!
    act(() => fill().toggle())
    expect(panelFull('full-switch', tab)).toBe(true)
    act(() => fill().toggle())
    expect(panelFull('full-switch', tab)).toBe(false)

    await harness.render(slot({ chatId: 'full-switch' }))
    expect(fullSwitch()).toBeNull()
  })

  it('draws what its page says about itself as main hands it to a task’s tab (L11 复核 11): one store, one rule', async () => {
    // On screen, the slot claims its page on the resident layer's store; main's relay then reaches the renderer's
    // host-action handler, which is `extensionSurfaceStore.say` with the slot's tab and no task.
    HTMLElement.prototype.checkVisibility = () => true
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 360, bottom: 400, width: 360, height: 400, toJSON: () => ({}) })
    {
      openPanelItem('group-2', folderItem())
      await harness.render(slot({ chatId: 'group-2' }))
      const claimOf = (chatId: string, itemId?: string) =>
        [...extensionViewStore.claims.values()].find(
          (claim) => claim.chatId === chatId && claim.itemId === itemId,
        )!
      act(() => extensionSurfaceStore.say(null, claimOf('group-2').tabId, { title: 'Board', badge: 3, error: 'boom' }))
      const page = residentPageKey(WORKSPACE_APP_KIND, residentPlace({ chatId: 'group-2' }))
      expect(extensionSurfaceStore.sharedState(page)).toEqual({ title: 'Board', badge: 3, error: 'boom' })
      expect(harness.container.textContent).toContain('Board')
      expect(harness.container.querySelector('[data-testid="group-app-slot-badge"]')?.textContent).toBe('3')
      expect(harness.container.querySelector('[data-testid="group-app-slot-error"]')?.getAttribute('title')).toBe('boom')
      // Control: words for a slot that is not this one do not show here.
      act(() => extensionSurfaceStore.say(null, 'some-other-slot', { title: 'Elsewhere' }))
      expect(harness.container.textContent).not.toContain('Elsewhere')
      // The resident layer forgets a page's words when the page goes (extension-view-layer): the header follows.
      act(() => extensionSurfaceStore.forgetShared(page))
      expect(harness.container.textContent).not.toContain('Board')
      expect(harness.container.querySelector('[data-testid="group-app-slot-error"]')).toBeNull()

      // A page opened for a file: its own slot, its own words; the group's page untouched.
      openPanelItem('group-4', { kind: WORKSPACE_APP_KIND, itemId: 'item-4', title: 'plan', fileName: 'plan.json', typedName: 'plan.json' })
      // (Its page waits for the group's shared packages to be read — a signed-in person's.)
      await harness.render(slot({ chatId: 'group-4' }))
      await act(async () => {})
      act(() => extensionSurfaceStore.say(null, claimOf('group-4', 'item-4').tabId, { title: 'Board' }))
      expect(harness.container.querySelector('[title="plan.json · Board"]')?.textContent).toBe('plan')
      expect(harness.container.textContent).not.toContain('Board')
      expect(extensionSurfaceStore.sharedState(residentPageKey(WORKSPACE_APP_KIND, residentPlace({ chatId: 'group-4' }))).title).toBeNull()
    }
  })

  // The board App came from a card in a chat (the only kind a group's newer package may replace, E-05), unless said.
  const install = (toolbar: { id: string; title: string }[], menu: { id: string; title: string }[], version = '1.0.0', origin = 'attachment') =>
    act(() =>
      installedExtensionsStore.applyList({
        extensions: toolbar === NONE ? [] : [{ id: 'board', name: 'Board', version, contributes: { tabs: [{ name: 'main', title: 'Board', toolbar, menu }] } }],
        invalid: [],
        origins: { board: origin },
      } as unknown as InstalledExtensionsList),
    )

  it('shows the toolbar and menu the App declared, as the task page reads them, and follows a new version', async () => {
    install([{ id: 'add', title: 'Add' }, { id: 'sort', title: 'Sort' }, { id: 'undo', title: 'Undo' }], [{ id: 'export', title: 'Export' }])
    openPanelItem('group-tools', boardPage())
    await harness.render(slot({ chatId: 'group-tools' }))
    const inline = () => [...harness.container.querySelectorAll('[data-command]')].map((node) => node.getAttribute('data-command'))
    expect(inline()).toEqual(['add', 'sort'])
    expect(harness.container.querySelector('[data-testid="group-app-slot-more"]')).not.toBeNull()

    install([{ id: 'add', title: 'Add' }], [])
    expect(inline()).toEqual(['add'])
    expect(harness.container.querySelector('[data-testid="group-app-slot-more"]')).toBeNull()
  })

  it('in a block the App\'s toolbar is the task page\'s command bar; nothing declared, no bar', async () => {
    install([{ id: 'add', title: 'Add' }, { id: 'sort', title: 'Sort' }, { id: 'undo', title: 'Undo' }], [{ id: 'export', title: 'Export' }])
    openPanelItem('group-tools-tabbed', boardPage())
    await harness.render(slot({ chatId: 'group-tools-tabbed', tabbed: true }))
    const bar = () => harness.container.querySelector('[role="toolbar"]')
    expect([...bar()!.querySelectorAll('button')].map((button) => button.textContent)).toEqual(['Add', 'Sort', 'Undo'])
    install([], [])
    expect(bar()).toBeNull()
  })

  it('reads what is installed straight from the store: the update bar and the 「no page」 note follow it', async () => {
    install([], [], '1.0.0')
    sharedHere.packages = new Map([['board', { manifest: { id: 'board', name: 'Board', version: '1.1.0' }, card: { source: { kind: 'url', url: 'https://files.invalid/board.zip' }, messageId: 'm-board' } }]])
    openPanelItem('group-3', boardPage())
    await harness.render(slot({ chatId: 'group-3' }))
    await act(async () => {})
    const bar = () => harness.container.querySelector('[data-testid="group-app-slot-update"]')
    const noPage = () => harness.container.querySelector('[data-testid="group-app-slot-no-page"]')
    expect(bar()?.getAttribute('data-version')).toBe('1.1.0')
    expect(noPage()).toBeNull()

    install([], [], '1.1.0')
    expect(bar()).toBeNull()
    install(NONE, [])
    expect(noPage()).not.toBeNull()
  })

  // 10-17: the market's office here, a newer package of it in the group — the bar offered 「更新」 and the install refused it
  // (E-05). An App that did not come from a chat gets no bar; the same App from a chat does (the case above).
  it('no update bar over an App that did not come from a chat (E-05)', async () => {
    install([], [], '1.0.0', 'market')
    sharedHere.packages = new Map([['board', { manifest: { id: 'board', name: 'Board', version: '1.1.0' }, url: 'https://files.invalid/board.zip' }]])
    openPanelItem('group-3-market', boardPage())
    await harness.render(slot({ chatId: 'group-3-market' }))
    await act(async () => {})
    expect(harness.container.querySelector('[data-testid="group-app-slot"]')).not.toBeNull()
    expect(harness.container.querySelector('[data-testid="group-app-slot-update"]')).toBeNull()
  })
})

// 「在本群打开」(app-redesign §5, 统筹 10-05): an App with a page of its own opens that page in the group's panel, the group
// its context; an App that only opens files opens where its files are (摩擦单 F51). Control (the parent commit): every App
// went to its files — one with none opened nothing at all.
describe('an App opened in the group (「在本群打开」)', () => {
  const installTabs = (tabs: { name: string; title: string; opensFiles?: Record<string, string[]>; chatFile?: string }[]) =>
    act(() => installedExtensionsStore.applyList({ extensions: [{ id: 'board', name: 'Board', version: '1.0.0', apiVersion: 14, contributes: { tabs } }], invalid: [] } as unknown as InstalledExtensionsList))

  it('the folder asked for is a tab of its own beside a remembered App, with no Back', async () => {
    const chatId = 'folder-entry-7590'
    const calendar = openPanelItem(chatId, { kind: 'day-calendar.main', title: '日历' })
    await harness.render(slot({ chatId }))
    expect(harness.container.querySelector('[data-app-kind]')?.getAttribute('data-app-kind')).toBe('day-calendar.main')
    ask(chatId, { app: 'workspace' })
    expect(harness.container.querySelector('[data-app-kind]')?.getAttribute('data-app-kind')).toBe(WORKSPACE_APP_KIND)
    expect(harness.container.querySelector('[data-testid="group-app-slot-back"]')).toBeNull()
    expect(isFolderItem(shownItem(chatId))).toBe(true)
    expect(panelTabsOf(chatId).map((tab) => tab.tabId), 'the folder beside the chat, the calendar still a tab').toEqual([shownPanelTab(chatId)?.tabId, calendar])
  })

  it('opens its own page here, with no file', async () => {
    const { appsHere } = await import('../../../../apps/desktop/src/components/appSlot/appsHere')
    vi.mocked(appsHere!.groupFilesOpenedBy).mockClear()
    installTabs([{ name: 'main', title: 'Board' }])
    await harness.render(slot({ chatId: 'group-5' }))
    ask('group-5', { app: 'board' })
    await act(async () => {})
    expect(shownItem('group-5')).toMatchObject({ kind: 'board.main', title: 'Board' })
    expect(shownItem('group-5')?.itemId).toBeUndefined()
    expect(appsHere!.groupFilesOpenedBy).not.toHaveBeenCalled()
  })

  // App 引用 pill: the place a pill points at goes with the file to whoever resolves who opens it (main on the desktop,
  // the phone's host there) — that is where the App that opens it is told, as the `link` event a gugu link brings.
  it('a file asked for at a place: the place goes to the host that resolves who opens it', async () => {
    const { appsHere } = await import('../../../../apps/desktop/src/components/appSlot/appsHere')
    vi.mocked(appsHere!.groupFileOpener).mockClear()
    vi.mocked(appsHere!.groupFileOpener).mockResolvedValue({ success: false, error: 'not in this test' })
    askChat('group-7', { itemId: 'item-7', at: { slide: '3', shape: '12' } })
    const asked = takeChatAsk('group-7')
    expect(asked).toEqual({ itemId: 'item-7', at: { slide: '3', shape: '12' } })
    expect(takeChatAsk('group-7')).toBeNull()
    await harness.render(slot({ chatId: 'group-7' }))
    ask('group-7', asked!)
    await act(async () => {})
    expect(appsHere!.groupFileOpener).toHaveBeenCalledWith({ chatId: 'group-7', itemId: 'item-7', at: { slide: '3', shape: '12' } })
    // Control: a plain link's file goes without one.
    vi.mocked(appsHere!.groupFileOpener).mockClear()
    await harness.render(slot({ chatId: 'group-8' }))
    ask('group-8', { itemId: 'item-8' })
    await act(async () => {})
    expect(appsHere!.groupFileOpener).toHaveBeenCalledWith({ chatId: 'group-8', itemId: 'item-8' })
  })

  it('an App of files only goes to its files', async () => {
    const { appsHere } = await import('../../../../apps/desktop/src/components/appSlot/appsHere')
    vi.mocked(appsHere!.groupFilesOpenedBy).mockClear()
    installTabs([{ name: 'main', title: 'Board', opensFiles: { chat: ['.board.json'] } }])
    await harness.render(slot({ chatId: 'group-6' }))
    ask('group-6', { app: 'board' })
    await act(async () => {})
    expect(appsHere!.groupFilesOpenedBy).toHaveBeenCalledWith({ chatId: 'group-6', extensionId: 'board' })
    expect(shownItem('group-6')).toBeNull()
  })

  // owner 10-24: one App's one resource is one tab, however it was opened; how only gives it its 上一页. Control (the parent
  // commit): the App opened as its own page, and the same board from the folder was a second tab beside it.
  it('an App naming its chat file (API 14) opens that file; the same file from the folder is that tab again, now with Back', async () => {
    const { appsHere } = await import('../../../../apps/desktop/src/components/appSlot/appsHere')
    installTabs([{ name: 'main', title: 'Board' }, { name: 'file', title: 'Board', opensFiles: { chat: ['.board.json'] }, chatFile: 'team.board.json' }])
    const chatId = 'group-9'
    const candidate = { extensionId: 'board', tabKind: 'board.file', tabTitle: 'Board', app: { name: 'Board' }, onlyTab: false, suffix: '.board.json' }
    const detail = { chatId, itemId: 'B', name: 'team.board.json', typedName: 'team.board.json', file: { document: true, contentType: 'application/json', version: 1, size: 2 }, choice: { kind: 'one', candidate } }
    vi.mocked(appsHere!.appChatFile).mockResolvedValue({ success: true, data: detail as never })
    await harness.render(slot({ chatId }))
    ask(chatId, { app: 'board' })
    await act(async () => {})
    expect(appsHere!.appChatFile).toHaveBeenCalledWith({ chatId, extensionId: 'board' })
    const board = shownPanelTab(chatId)
    expect(board?.item).toMatchObject({ kind: 'board.file', itemId: 'B', title: 'team' })
    expect(harness.container.querySelector('[data-testid="group-app-slot-back"]'), 'opened from the chat: no 上一页').toBeNull()
    const folder = openPanelItem(chatId, folderItem())
    ask(chatId, { itemId: 'B', opener: detail as never, fromPage: true })
    await act(async () => {})
    expect(panelTabsOf(chatId).map((tab) => tab.item.itemId ?? 'folder')).toEqual(['B', 'folder'])
    expect(shownPanelTab(chatId)?.tabId, 'the tab already there').toBe(board!.tabId)
    act(() => (harness.container.querySelector('[data-testid="group-app-slot-back"]') as HTMLButtonElement).click())
    expect(shownPanelTab(chatId)?.tabId).toBe(folder)
  })
})
