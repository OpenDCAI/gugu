// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createReactHarness } from '../../../support/testHarness'

/**
 * 「在本群打开」(app-redesign §5, 统筹 10-05): one way to open an App from a chat. A card's 「打开」 asks it (`openApp`) and the
 * chat on screen answers (`useOpenApp`): in this chat's panel — a group's, a topic's or (主人 10-05「私聊也是得有面板的」)
 * a private chat's, on the desktop as on the phone. Whether a device can use an App at all is the host's to say by what it
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
  appsHere: { runs: () => host.runs, grantable: (manifest: unknown) => host.grantable(manifest), installAttachment: vi.fn(), groupFileOpener: vi.fn(), groupFilesOpenedBy: vi.fn(), setOpenWithDefault: vi.fn() },
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
const { openApp, useOpenApp } = await import('../../../../apps/desktop/src/components/appSlot/useOpenApp')
const { ExtensionBundleCard } = await import('../../../../apps/desktop/src/components/extensionBundle/ExtensionBundleCard')
const { ChatStoreProvider } = await import('../../../../apps/desktop/src/store/chatContext')
const { installedExtensionsStore } = await import('../../../../apps/desktop/src/session/renderer/features/extensions/installed-extensions-store')
const { UI_EVENTS } = await import('../../../../apps/desktop/src/lib/uiEvents')
const { useTopicWorkspace } = await import('../../../../apps/desktop/src/components/appSlot/useTopicWorkspace')
const { groupSlotMemory } = await import('../../../../apps/desktop/src/components/appSlot/groupSlotMemory')
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

describe('the chat on screen answers 「在本群打开」 (useOpenApp)', () => {
  let answered: ReturnType<typeof useOpenApp> = null
  const openPanel = vi.fn()
  const Chat = ({ id }: { id: string }) => {
    answered = useOpenApp(id, openPanel)
    return null
  }
  beforeEach(() => {
    answered = null
    openPanel.mockClear()
  })

  it('a topic opens it in its panel', async () => {
    await harness.render(createElement(Chat, { id: 'topic-1' }))
    act(() => openApp('board', 'topic-1'))
    expect(openPanel).toHaveBeenCalledTimes(1)
    expect(answered).toMatchObject({ chatId: 'topic-1', extensionId: 'board' })
  })

  it('another chat than the one on screen is not answered here', async () => {
    await harness.render(createElement(Chat, { id: 'group-1' }))
    act(() => openApp('board', 'group-2'))
    expect(openPanel).not.toHaveBeenCalled()
    expect(answered).toBeNull()
  })

  it('a private chat opens it in its own panel too — not the task side', async () => {
    const revealed = vi.fn()
    window.addEventListener(UI_EVENTS.sessionpageReveal, revealed)
    try {
      install(app([OWN_PAGE]))
      await harness.render(createElement(Chat, { id: 'dm-1' }))
      act(() => openApp('board', 'dm-1'))
      expect(openPanel).toHaveBeenCalledTimes(1)
      expect(revealed).not.toHaveBeenCalled()
      expect(answered).toMatchObject({ chatId: 'dm-1', extensionId: 'board' })
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

  // 125 10-06 (phone cell 1): the phone stopped asking for agents:read, but its card still said the App would 「看到这个 App
  // 自己起的 agent」 — a phone neither asks nor gives that. A card says what this device's consent asks (`grantable`).
  // Control (the parent commit): the phone's card listed the agents line as the desktop's does.
  it('the card says only what this device can grant: on the phone an agents-only App asks for nothing; the desktop lists it', async () => {
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
    // The phone writes it as an App that asks for nothing does; the desktop as before.
    card.manifest = app([OWN_PAGE])
    harness.cleanup()
    harness = createReactHarness()
    await show({ id: 'group-1', kind: 'group' })
    expect(onPhone).toBe(permissions())
    expect(onDesktop).not.toBe(onPhone)
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

describe('a topic beside its group answers for itself (useTopicWorkspace)', () => {
  const originalCheckVisibility = HTMLElement.prototype.checkVisibility
  beforeEach(() => {
    // jsdom has no checkVisibility: an unseen slot claims no page, which is all this needs of it.
    HTMLElement.prototype.checkVisibility = () => false
  })
  afterEach(() => {
    HTMLElement.prototype.checkVisibility = originalCheckVisibility
  })

  it("a card in the topic opens the App in the topic's own pane — the group on screen does not answer for it", async () => {
    install(app([OWN_PAGE]))
    const Pane = () => useTopicWorkspace('topic-9', false, () => {}).view as never
    await harness.render(createElement(Pane))
    const pane = () => harness.container.querySelector('[data-testid="topic-split-workspace"]')
    expect(pane()).toBeNull()
    act(() => openApp('board', 'topic-9'))
    await act(async () => {})
    expect(pane()).not.toBeNull()
    expect(groupSlotMemory.opened('topic-9')).toMatchObject({ kind: 'board.main' })
  })
})
