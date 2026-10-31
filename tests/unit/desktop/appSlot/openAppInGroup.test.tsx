// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createReactHarness } from '../../../support/testHarness'

/**
 * 「在本群打开」(app-redesign §5, 统筹 10-05): one way to open an App from a chat. A card's 「打开」 asks it (`openApp`) and the
 * source chat on screen answers (`useChatOpener`, every ask of the chat): a tab beside the group or private chat, also used by its topics.
 * This holds on the desktop as on the phone. Whether a device can use an App at all is the host's to say by what it
 * can do (`phoneRuns`), never by which files the App opens. Control (the parent commit): a private chat answered nothing
 * and its card said to open the App in a group.
 */

const host = vi.hoisted(() => ({ kind: 'electron' as 'electron' | 'capacitor', runs: true, grantable: (manifest: unknown) => manifest }))
vi.mock('../../../../apps/desktop/src/platform', () => ({
  get platform() {
    return { kind: host.kind, capabilities: { appUpdates: false, notifications: false, rendererCommandBridge: false } }
  },
}))
vi.mock('../../../../apps/desktop/src/components/appSlot/appsHere', () => ({
  appsHere: { runs: () => host.runs, grantable: (manifest: unknown) => host.grantable(manifest), installAttachment: vi.fn(), groupFileOpener: vi.fn(), groupFilesOpenedBy: vi.fn(async () => ({ success: true, data: [] })), setOpenWithDefault: vi.fn() },
}))
const card = vi.hoisted(() => ({ manifest: null as unknown }))
vi.mock('../../../../apps/desktop/src/components/extensionBundle/sharedPackages', () => ({
  summaryOf: async () => ({ ok: true, manifest: card.manifest }),
  packageKey: (card: { source: { kind: string; url?: string }; messageId: string }) => (card.source.kind === 'url' ? `url:${card.source.url}` : `msg:${card.messageId}`),
  installPackageOf: (card: { messageId: string }) => ({ messageId: card.messageId }),
  showPackage: () => () => {},
  newestShownPackage: () => undefined,
  shownPackagesVersion: () => 0,
  subscribeShownPackages: () => () => {},
  sharedPackagesOf: async () => new Map(),
  subscribeSharedPackages: () => () => {},
}))

const { phoneRuns } = await import('../../../../apps/desktop/src/components/appSlot/phoneAppHost')
const { useChatOpener } = await import('../../../../apps/desktop/src/components/appSlot/useChatOpener')
const { ExtensionBundleCard } = await import('../../../../apps/desktop/src/components/extensionBundle/ExtensionBundleCard')
const { ChatStoreProvider } = await import('../../../../apps/desktop/src/store/chatContext')
const { installedExtensionsStore } = await import('../../../../apps/desktop/src/session/renderer/features/extensions/installed-extensions-store')
const { UI_EVENTS } = await import('../../../../apps/desktop/src/lib/uiEvents')
const { folderItem } = await import('../../../../apps/desktop/src/session/renderer/features/chats/chat-tabs/chat-panel-item')
const { askChat, openPanelItem, panelTabsOf, returnToOf, shownPanelTab } = await import('../../../../apps/desktop/src/session/renderer/features/chats/chat-tabs/chat-layouts')
const { grantableBy } = await import('../../../../apps/desktop/src/session/shared/extensions/attachment-install')
const { PHONE_CAPABILITIES } = await import('../../../../apps/desktop/src/components/appSlot/phoneApps')

type Tab = { name: string; title: string; opensFiles?: Record<string, string[]> }
const app = (tabs: Tab[], capabilities: string[] = []) =>
  ({ id: 'board', name: 'Board', version: '1.0.0', apiVersion: 3, entry: 'index.html', contributes: { tabs }, permissions: { capabilities } }) as never
const OWN_PAGE: Tab = { name: 'main', title: 'Board' }
const GROUP_FILES: Tab = { name: 'main', title: 'Board', opensFiles: { chat: ['.board.json'] } }
const SESSION_FILES: Tab = { name: 'main', title: 'Board', opensFiles: { session: ['TODO.md'] } }
const install = (manifest: unknown) =>
  act(() => installedExtensionsStore.applyList({ extensions: manifest ? [manifest] : [], invalid: [] } as never))

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  harness = createReactHarness()
  host.kind = 'electron'
  host.runs = true
  host.grantable = (manifest) => manifest
})
afterEach(() => {
  harness.cleanup()
  install(null)
})

describe('the phone can use an App that has something to open here (phoneRuns)', () => {
  it('a page of its own or a tab of group files — whatever it asks for (真源 §2.6: never hidden for a capability)', () => {
    expect(phoneRuns(app([OWN_PAGE]))).toBe(true)
    expect(phoneRuns(app([GROUP_FILES], ['files:read', 'files:write']))).toBe(true)
    expect(phoneRuns(app([OWN_PAGE], ['agents:tools']))).toBe(true)
    // What only a computer has is not on the phone page's gugu, and not in its capabilities: the App still opens.
    expect(phoneRuns(app([OWN_PAGE], ['agents:read']))).toBe(true)
    expect(phoneRuns(app([GROUP_FILES], ['agents:control', 'files:read']))).toBe(true)
  })

  it('not one with nothing to open here', () => {
    expect(phoneRuns(app([SESSION_FILES]))).toBe(false)
  })
})

describe('the chat on screen answers 「在本群打开」 (useChatOpener)', () => {
  const Chat = ({ id }: { id: string }) => {
    useChatOpener(id)
    return null
  }
  const askNow = (chatId: string, what: Parameters<typeof askChat>[1]) =>
    act(() => { askChat(chatId, what); window.dispatchEvent(new CustomEvent(UI_EVENTS.chatAsked)) })
  const fileOpener = (chatId: string, itemId: string) => ({
    chatId, itemId, name: `${itemId}.board.json`, typedName: `${itemId}.board.json`,
    choice: { kind: 'one', candidate: { extensionId: 'board', tabKind: 'board.main', tabTitle: 'Board', app: { name: 'Board' }, onlyTab: true, suffix: '.board.json' } },
  }) as never

  it('a source chat opens its requested App in a tab beside it', async () => {
    install(app([OWN_PAGE]))
    await harness.render(createElement(Chat, { id: 'source-1' }))
    askNow('source-1', { app: 'board' })
    const tab = shownPanelTab('source-1')
    expect(tab?.item).toMatchObject({ kind: 'board.main' })
    expect(returnToOf('source-1', tab!.tabId), 'an App opened from the chat has no 上一页').toBeNull()
  })

  it('a page beside the chat asked: the tab on screen is the 上一页 of what it opens; an App asked there has none (owner 10-24)', async () => {
    install(app([OWN_PAGE]))
    await harness.render(createElement(Chat, { id: 'source-panel' }))
    const folder = openPanelItem('source-panel', folderItem())!
    askNow('source-panel', { itemId: 'F1', opener: fileOpener('source-panel', 'F1'), fromPage: true })
    const file = shownPanelTab('source-panel')
    expect(file?.item).toMatchObject({ itemId: 'F1' })
    expect(returnToOf('source-panel', file!.tabId)).toBe(folder)
    askNow('source-panel', { app: 'board' })
    const board = shownPanelTab('source-panel')
    expect(board?.item).toMatchObject({ kind: 'board.main' })
    expect(board?.item.itemId).toBeUndefined()
    expect(returnToOf('source-panel', board!.tabId)).toBeNull()
  })

  it('another chat than the one on screen is not answered here', async () => {
    install(app([OWN_PAGE]))
    await harness.render(createElement(Chat, { id: 'group-1' }))
    askNow('group-2', { app: 'board' })
    expect(panelTabsOf('group-1')).toEqual([])
    expect(panelTabsOf('group-2')).toEqual([])
  })

  it('a private chat opens it beside itself too — not the task side', async () => {
    const revealed = vi.fn()
    window.addEventListener(UI_EVENTS.sessionpageReveal, revealed)
    try {
      install(app([OWN_PAGE]))
      await harness.render(createElement(Chat, { id: 'dm-1' }))
      askNow('dm-1', { app: 'board' })
      expect(revealed).not.toHaveBeenCalled()
      expect(shownPanelTab('dm-1')?.item).toMatchObject({ kind: 'board.main' })
    } finally {
      window.removeEventListener(UI_EVENTS.sessionpageReveal, revealed)
    }
  })
})

describe("a card's 「打开」 is 「在本群打开」", () => {
  const show = async (chat: { id: string; kind: 'group' | 'dm' }) => {
    const value = { chats: [{ id: chat.id, kind: chat.kind }] } as never
    await harness.render(
      createElement(ChatStoreProvider, { value }, createElement(ExtensionBundleCard, {
        meta: { sizeBytes: 10, fileName: 'board.guguext' },
        card: { source: { kind: 'url', url: 'https://files.invalid/board.guguext' }, messageId: 'm1' },
        isMine: false,
        chatId: chat.id,
      })),
    )
    await act(async () => {})
  }
  const button = () => harness.container.querySelector<HTMLButtonElement>('[data-testid="extension-bundle-card-install"]')

  it('in a group, an installed App with no group files opens in this group — not on the task page', async () => {
    card.manifest = app([OWN_PAGE])
    install(card.manifest)
    const opened = vi.fn()
    const revealed = vi.fn()
    window.addEventListener(UI_EVENTS.openApp, opened)
    window.addEventListener(UI_EVENTS.sessionpageReveal, revealed)
    try {
      await show({ id: 'group-1', kind: 'group' })
      expect(button()?.dataset.action).toBe('open')
      act(() => button()!.click())
      expect((opened.mock.calls[0]![0] as CustomEvent).detail).toEqual({ extensionId: 'board', chatId: 'group-1' })
      expect(revealed).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener(UI_EVENTS.openApp, opened)
      window.removeEventListener(UI_EVENTS.sessionpageReveal, revealed)
    }
  })

  // The repo's 7 Apps opened in a group (L11 复核 49 acceptance): ext-debug opens only a session's `.probe` files, and its
  // 「打开」 in a group opened nothing — the panel showed what it had shown before.
  it('in a group, an installed App that only opens a session\'s files has no 「打开」: it says it is used in sessions', async () => {
    card.manifest = app([SESSION_FILES])
    install(card.manifest)
    await show({ id: 'group-1', kind: 'group' })
    expect(button()).toBeNull()
    expect(harness.container.querySelector('[data-testid="extension-bundle-card-opens-in-sessions"]')).not.toBeNull()
  })

  it('a device that cannot use it says so, instead of an install', async () => {
    card.manifest = app([OWN_PAGE], ['agents:read'])
    host.kind = 'capacitor'
    host.runs = false
    await show({ id: 'group-1', kind: 'group' })
    expect(button()).toBeNull()
    expect(harness.container.querySelector('[data-testid="extension-bundle-card-elsewhere"]')).not.toBeNull()
  })

  // The card and the install sheet must describe the same supported capabilities.
  it('the card shows agent-read permission on both phone and desktop', async () => {
    const permissions = () => harness.container.querySelector('[data-testid="extension-bundle-card-permissions"]')?.textContent
    card.manifest = app([OWN_PAGE], ['agents:read'])
    await show({ id: 'group-1', kind: 'group' })
    const onDesktop = permissions()
    harness.cleanup()
    harness = createReactHarness()
    host.kind = 'capacitor'
    host.grantable = (manifest) => grantableBy(manifest as never, PHONE_CAPABILITIES)
    await show({ id: 'group-1', kind: 'group' })
    const onPhone = permissions()
    // An App with no permissions remains distinct from one reading its agents.
    card.manifest = app([OWN_PAGE])
    harness.cleanup()
    harness = createReactHarness()
    await show({ id: 'group-1', kind: 'group' })
    expect(onPhone).not.toBe(permissions())
    expect(onDesktop).toBe(onPhone)
  })

  it.each(['electron', 'capacitor'] as const)('in a private chat (%s), an installed App opens in this private chat, as in a group', async (kind) => {
    card.manifest = app([GROUP_FILES])
    install(card.manifest)
    host.kind = kind
    const opened = vi.fn()
    window.addEventListener(UI_EVENTS.openApp, opened)
    try {
      await show({ id: 'dm-1', kind: 'dm' })
      expect(button()?.dataset.action).toBe('open')
      act(() => button()!.click())
      expect((opened.mock.calls[0]![0] as CustomEvent).detail).toEqual({ extensionId: 'board', chatId: 'dm-1' })
    } finally {
      window.removeEventListener(UI_EVENTS.openApp, opened)
    }
  })
})
