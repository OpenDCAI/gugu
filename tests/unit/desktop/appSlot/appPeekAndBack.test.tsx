// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createReactHarness } from '../../../support/testHarness'
import { until } from '../../../support/awaitCondition'

/**
 * G1 / G2 (看板 10-19, owner 「如果链接到文件就必须跳转才能打开的话会不太方便」): an App's page in a chat's panel opens a
 * file beside itself (`peek`) and the page stays as it was — on the desktop it keeps its claim on its slot while covered, so
 * a page made for a file is not thrown away. And a file opened from an App (no peek) goes back to that App, not past it to
 * the folder. Control (the parent commit): back went to the folder; a covered slot gave its page up.
 */

vi.mock('../../../../apps/desktop/src/platform', () => ({
  platform: { kind: 'electron', capabilities: { appUpdates: false, notifications: false, rendererCommandBridge: false } },
}))
vi.mock('../../../../apps/desktop/src/components/appSlot/appsHere', () => ({
  appsHere: { runs: () => true, grantable: (manifest: unknown) => manifest, installAttachment: vi.fn(), marketOffers: vi.fn(async () => ({ success: true, data: [] })), groupFileOpener: vi.fn(), groupFilesOpenedBy: vi.fn(async () => ({ success: true, data: [] })), setOpenWithDefault: vi.fn() },
}))
vi.mock('../../../../apps/desktop/src/components/extensionBundle/sharedPackages', () => ({
  sharedPackagesOf: async () => new Map(),
  subscribeSharedPackages: () => () => {},
}))

const { ask, chatTabs, shownItem } = await import('./chatTabsHarness')
const { folderItem, isFolderItem } = await import('../../../../apps/desktop/src/session/renderer/features/chats/chat-tabs/chat-panel-item')
const { chatAlone, chatLayoutOf, closeChatTab, openPanelItem, panelFull, panelTabsOf, shownPanelTab } = await import('../../../../apps/desktop/src/session/renderer/features/chats/chat-tabs/chat-layouts')
import { tabFullscreen } from '../../../../apps/desktop/src/session/renderer/features/tabs/tab-fullscreen'
const { AppPeekSlot } = await import('../../../../apps/desktop/src/components/appSlot/AppPeekSlot')
const { ClaimedPage } = await import('../../../../apps/desktop/src/components/appSlot/ClaimedPage')
const { peekStore } = await import('../../../../apps/desktop/src/session/renderer/features/extensions/peek-store')
const { installedExtensionsStore } = await import('../../../../apps/desktop/src/session/renderer/features/extensions/installed-extensions-store')
const { extensionViewStore } = await import('../../../../apps/desktop/src/session/renderer/features/extensions/extension-view-store')

const board = { id: 'kanban', name: 'Kanban', version: '1.0.0', apiVersion: 3, defaultLocale: 'en', entry: 'index.html', contributes: { tabs: [{ name: 'board', title: 'Kanban' }] } }
const pdf = { extensionId: 'pdf', tabKind: 'pdf.viewer', tabTitle: 'PDF', app: { name: 'PDF', defaultLocale: 'en' }, onlyTab: true, suffix: '.pdf', state: false }

let harness: ReturnType<typeof createReactHarness>
/** The claims and releases slots make on the resident layer's store, by slot. */
const slotEvents: { type: string; slotId: string }[] = []
const slotOfToken = new Map<number, string>()
const spies: { mockRestore(): void }[] = []
const original = { checkVisibility: HTMLElement.prototype.checkVisibility, rect: HTMLElement.prototype.getBoundingClientRect }
beforeEach(() => {
  harness = createReactHarness()
  slotEvents.length = 0
  const claim = extensionViewStore.claim.bind(extensionViewStore)
  const release = extensionViewStore.release.bind(extensionViewStore)
  spies.push(vi.spyOn(extensionViewStore, 'claim').mockImplementation((kind, target) => {
    const token = claim(kind, target)
    slotOfToken.set(token, target.tabId)
    slotEvents.push({ type: 'claim', slotId: target.tabId })
    return token
  }))
  spies.push(vi.spyOn(extensionViewStore, 'release').mockImplementation((kind, token) => {
    slotEvents.push({ type: 'release', slotId: slotOfToken.get(token) ?? '?' })
    release(kind, token)
  }))
  // Seen while no ancestor hides it (what the browser answers), at a panel's size.
  HTMLElement.prototype.checkVisibility = function (this: HTMLElement) {
    return !this.closest('.invisible')
  }
  HTMLElement.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 520, bottom: 800, width: 520, height: 800, toJSON: () => ({}) })
  act(() => installedExtensionsStore.applyList({ extensions: [board], invalid: [] } as never))
})
afterEach(() => {
  harness.cleanup()
  for (const spy of spies.splice(0)) spy.mockRestore()
  HTMLElement.prototype.checkVisibility = original.checkVisibility
  HTMLElement.prototype.getBoundingClientRect = original.rect
  act(() => installedExtensionsStore.applyList({ extensions: [], invalid: [] } as never))
})

const button = (testId: string) => harness.container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)

describe('G2: back from a file opened by an App goes back to that App', () => {
  it('a file its page opened goes back to the App; the App, opened from the chat, has no Back and closes to the chat', async () => {
    const chatId = 'back-1'
    await harness.render(chatTabs({ chatId }))
    ask(chatId, { app: 'kanban' })
    const app = shownPanelTab(chatId)
    expect(app?.item.kind).toBe('kanban.board')
    expect(panelTabsOf(chatId).map((tab) => tab.tabId), '对照:父提交在它前面多一枚文件夹(null)').toEqual([app!.tabId])
    const opener = { chatId, itemId: 'deck', name: 'deck.pdf', typedName: 'deck.pdf', choice: { kind: 'one', candidate: pdf } }
    ask(chatId, { itemId: 'deck', opener: opener as never, fromPage: true })
    expect(shownItem(chatId)).toMatchObject({ kind: 'pdf.viewer', itemId: 'deck' })
    act(() => button('group-app-slot-back')!.click())
    expect(shownPanelTab(chatId)?.tabId).toBe(app!.tabId)
    expect(button('group-app-slot-back'), 'opened straight from the chat: no 上一页').toBeNull()
    act(() => button('group-app-slot-close')!.click())
    expect(shownItem(chatId)).toBeNull()
    expect(chatAlone(chatId)).toBe(true)
  })

  it('an App opened while another tab is shown: no Back, and closing it leaves the chat with that tab kept (as a task\'s side page)', async () => {
    const chatId = 'app-from-object'
    const previous = openPanelItem(chatId, { kind: 'pdf.viewer', itemId: 'source', title: 'source.pdf' })!
    await harness.render(chatTabs({ chatId }))
    ask(chatId, { app: 'kanban' })
    expect(shownItem(chatId)?.kind).toBe('kanban.board')
    expect(button('group-app-slot-back')).toBeNull()
    act(() => button('group-app-slot-close')!.click())
    expect(chatAlone(chatId)).toBe(true)
    expect(panelTabsOf(chatId).map((tab) => tab.tabId)).toEqual([previous])
  })
})

describe('tabbed group panel expansion', () => {
  // owner 10-26 选 A:页里不再横一行,「最大化 / 还原」长在页签上(TabHost.tabFill,页签那颗钮和双击)。
  it.each([false, true])('expands and restores the current page from its tab (App=%s)', async (app) => {
    const chatId = `expand-panel-${app}`
    await harness.render(chatTabs({ chatId, tabbed: true }))
    ask(chatId, { app: app ? 'kanban' : 'workspace' })
    const opened = shownPanelTab(chatId)!
    expect(app ? opened.item.kind : isFolderItem(opened.item)).toBe(app ? 'kanban.board' : true)
    expect(harness.container.querySelector('[data-testid="group-app-slot-bar"]'), 'no row under the tab').toBeNull()
    const pane = chatLayoutOf(chatId).groups[0]!.pane
    const fill = () => pane.tabFill(opened.tabId)!
    expect(fill().full).toBe(false)
    act(() => fill().toggle())
    // 全屏只盖住工作区,❌ 动布局:面板仍和对话并排着(panelFull 是另一件事:拆开、对话不在)。
    expect(tabFullscreen.isOn(pane, opened.tabId)).toBe(true)
    expect(panelFull(chatId, opened.tabId)).toBe(false)
    expect(fill().full).toBe(true)
    act(() => fill().toggle())
    expect(tabFullscreen.isOn(pane)).toBe(false)
    expect(panelFull(chatId, opened.tabId)).toBe(false)
    expect(shownPanelTab(chatId)?.tabId).toBe(opened.tabId)
    expect(chatAlone(chatId)).toBe(false)
  })
})

describe('message attachment entry', () => {
  const file = (chatId: string, itemId: string) => ({ chatId, itemId, name: `${itemId}.pdf`, typedName: `${itemId}.pdf`, choice: { kind: 'one', candidate: pdf } }) as never

  it('a message file has Close without Back and restores its caller', async () => {
    const chatId = 'message-entry'
    const restore = vi.fn()
    await harness.render(chatTabs({ chatId }))
    ask(chatId, { itemId: 'message-file', restore, opener: file(chatId, 'message-file') })
    expect(button('group-app-slot-back')).toBeNull()
    const close = button('group-app-slot-close')
    expect(close).not.toBeNull()
    act(() => close!.click())
    expect(restore).toHaveBeenCalledTimes(1)
    expect(chatAlone(chatId)).toBe(true)
    expect(panelTabsOf(chatId).some((tab) => tab.item.itemId === 'message-file')).toBe(false)
  })

  it('in a block a message file has neither Back nor Close of its own (its tab is its ×); closing it restores its caller', async () => {
    const chatId = 'message-entry-tabbed'
    const restore = vi.fn()
    await harness.render(chatTabs({ chatId, tabbed: true }))
    ask(chatId, { itemId: 'message-file', restore, opener: file(chatId, 'message-file') })
    expect(button('group-app-slot-back')).toBeNull()
    expect(button('group-app-slot-close')).toBeNull()
    act(() => closeChatTab(chatId, shownPanelTab(chatId)!.tabId))
    expect(restore).toHaveBeenCalledTimes(1)
    expect(panelTabsOf(chatId)).toEqual([])
  })

  it('the same file from a folder keeps Back and returns to its list', async () => {
    const chatId = 'folder-entry'
    const folder = openPanelItem(chatId, folderItem())!
    await harness.render(chatTabs({ chatId }))
    ask(chatId, { itemId: 'message-file', opener: file(chatId, 'message-file'), fromPage: true })
    act(() => button('group-app-slot-back')!.click())
    expect(shownPanelTab(chatId)?.tabId).toBe(folder)
    expect(chatAlone(chatId)).toBe(false)
  })

  it('an App opened from a message keeps its internal trail before closing to the message', async () => {
    const chatId = 'message-trail'
    const restore = vi.fn()
    await harness.render(chatTabs({ chatId }))
    ask(chatId, { itemId: 'first', restore, opener: file(chatId, 'first') })
    ask(chatId, { itemId: 'second', opener: file(chatId, 'second'), fromPage: true })
    act(() => button('group-app-slot-back')!.click())
    expect(shownItem(chatId)?.itemId).toBe('first')
    expect(restore).not.toHaveBeenCalled()
    expect(button('group-app-slot-back')).toBeNull()
    act(() => button('group-app-slot-close')!.click())
    expect(restore).toHaveBeenCalledTimes(1)
  })

  it('the host preview also closes a message attachment instead of showing the folder', async () => {
    const chatId = 'message-raw'
    const restore = vi.fn()
    await harness.render(chatTabs({ chatId }))
    ask(chatId, { itemId: 'raw', restore, opener: {
      chatId, itemId: 'raw', name: 'raw.opaque', typedName: 'raw.opaque', choice: { kind: 'none' },
      file: { document: false, contentType: 'application/octet-stream', version: 1, size: 3 },
    } as never })
    const header = harness.container.querySelector('[data-testid="message-file-preview-panel"] header')!
    expect(header.querySelectorAll('button')).toHaveLength(1)
    act(() => (header.querySelector('button') as HTMLButtonElement).click())
    expect(restore).toHaveBeenCalledTimes(1)
    expect(chatAlone(chatId)).toBe(true)
  })

  it('choosing an App for a message file keeps the message entry', async () => {
    const chatId = 'message-choice'
    const restore = vi.fn()
    await harness.render(chatTabs({ chatId }))
    ask(chatId, { itemId: 'choice', restore, opener: {
      ...(file(chatId, 'choice') as object), choice: { kind: 'choose', suffix: '.pdf', candidates: [pdf] },
    } as never })
    act(() => (harness.container.querySelector('[data-open-with="pdf.viewer"]') as HTMLButtonElement).click())
    expect(button('group-app-slot-back')).toBeNull()
    act(() => button('group-app-slot-close')!.click())
    expect(restore).toHaveBeenCalledTimes(1)
  })
})

describe('G1: something opened over a page keeps the page', () => {
  it('a page made for a file, covered by a peek: its claim is kept (not released), and it is the same element after', async () => {
    const page = createElement(ClaimedPage, { slotId: 'slot-x', chatId: 'c-1', kind: 'pdf.viewer', itemId: 'f-1' })
    await harness.render(createElement(AppPeekSlot, { sessionId: null, tabId: 'slot-x', children: page }))
    const box = harness.container.querySelector('[data-testid="app-peek-slot"] > div')!
    expect(slotEvents).toEqual([{ type: 'claim', slotId: 'slot-x' }])
    await act(async () => {
      peekStore.open(null, 'slot-x', { kind: 'chat', detail: { chatId: 'c-1', itemId: 'f-2', name: 'b.pdf', typedName: 'b.pdf', choice: { kind: 'one', candidate: pdf }, file: { document: false, contentType: 'application/pdf', version: 1, size: 1 } } })
    })
    // Narrow (520): it opens over the page, which is hidden — and keeps its claim; the peek claims a page of its own.
    expect(harness.container.querySelector('[data-testid="app-peek-slot"]')?.getAttribute('data-peek')).toBe('over')
    expect(box.classList.contains('invisible')).toBe(true)
    expect(slotEvents.filter((event) => event.slotId === 'slot-x'), '对照:不认 PeekCovered 时这里多一条 release').toEqual([{ type: 'claim', slotId: 'slot-x' }])
    // What opens is drawn once its module is in (loaded when something first opens).
    await until('the peek claims a page of its own', () => slotEvents.some((event) => event.type === 'claim' && event.slotId === ':slot-x#peek'))
    await act(async () => peekStore.close(null, 'slot-x'))
    expect(harness.container.querySelector('[data-testid="app-peek-slot"] > div')).toBe(box)
    expect(slotEvents).toContainEqual({ type: 'release', slotId: ':slot-x#peek' })
    expect(slotEvents.filter((event) => event.slotId === 'slot-x')).toEqual([{ type: 'claim', slotId: 'slot-x' }])
  })
})

describe('G1: a task\'s file beside an App in a chat\'s panel', () => {
  it('is drawn in the shell, with no session page around it, in the session page\'s own words', async () => {
    const { translateSessionMessage } = await import('../../../../apps/desktop/src/session/renderer/localization/locale-store')
    // A render error with nothing to catch it unmounts the tree: read it, so the control fails on it instead of waiting.
    const thrown: string[] = []
    const onError = (event: ErrorEvent) => thrown.push(String(event.error?.message ?? event.message))
    window.addEventListener('error', onError)
    await harness.render(createElement(AppPeekSlot, { sessionId: null, tabId: 'slot-y', narrow: true, children: createElement('div') }))
    await act(async () => {
      peekStore.open(null, 'slot-y', { kind: 'local', place: { workspace: 'session:s-1' }, projectId: 'p-1', workspaceId: 'w-1', path: 'docs/blob.zip', absolutePath: '/work/docs/blob.zip', name: 'blob.zip', ask: false })
    })
    // 对照(父提交):useSessionMessages 读 session-ui 的 MessageProvider,壳里没有它 ⇒ 渲染期抛错,整个主界面换成出错页。
    const words = translateSessionMessage('file.openWithSystem')
    const drawn = () => [...harness.container.querySelectorAll('[data-testid="app-peek"] button')].some((button) => button.textContent === words)
    await until('the file is drawn beside the page, or its render threw', () => drawn() || thrown.length > 0)
    window.removeEventListener('error', onError)
    expect(thrown).toEqual([])
    expect(drawn()).toBe(true)
    await act(async () => peekStore.close(null, 'slot-y'))
  })
})
