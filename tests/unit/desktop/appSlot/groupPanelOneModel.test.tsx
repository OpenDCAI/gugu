// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ComponentProps } from 'react'
import { createReactHarness } from '../../../support/testHarness'
import { GroupAppSlot, WORKSPACE_APP_KIND } from '../../../../apps/desktop/src/components/appSlot/GroupAppSlot'
import { groupSlotMemory } from '../../../../apps/desktop/src/components/appSlot/groupSlotMemory'
import { extensionSurfaceStore } from '../../../../apps/desktop/src/session/renderer/features/extensions/extension-surface-store'
import { extensionViewStore, residentPageKey, residentPlace } from '../../../../apps/desktop/src/session/renderer/features/extensions/extension-view-store'
import { listenForAppSlots } from '../../../../apps/desktop/src/session/renderer/features/extensions/app-slot-events'
import {
  installedExtensionsStore,
  type InstalledExtensionsList,
} from '../../../../apps/desktop/src/session/renderer/features/extensions/installed-extensions-store'
import { AuthContext } from '../../../../apps/desktop/src/store/auth'

vi.mock('../../../../apps/desktop/src/platform', () => ({
  platform: { kind: 'electron', capabilities: { appUpdates: false, notifications: false, rendererCommandBridge: false } },
}))
// No App runtime under jsdom: this device's Apps answer nothing; the group's shared packages are the test's.
vi.mock('../../../../apps/desktop/src/components/appSlot/appsHere', () => ({
  appsHere: { runs: () => true, grantable: (manifest: unknown) => manifest, installAttachment: vi.fn(), marketOffers: vi.fn(async () => ({ success: true, data: [] })), groupFileOpener: vi.fn(), groupFilesOpenedBy: vi.fn(async () => ({ success: true, data: [] })), setOpenWithDefault: vi.fn() },
}))
const sharedHere = vi.hoisted(() => ({ packages: new Map<string, unknown>() }))
vi.mock('../../../../apps/desktop/src/components/extensionBundle/sharedPackages', () => ({
  sharedPackagesOf: async () => sharedHere.packages,
  subscribeSharedPackages: () => () => {},
  packageKey: (card: { source: { kind: string; url?: string }; messageId: string }) => (card.source.kind === 'url' ? `url:${card.source.url}` : `msg:${card.messageId}`),
  installPackageOf: (card: { messageId: string }) => ({ messageId: card.messageId }),
}))

/**
 * The group's side panel and the session page's right panel are one model (统筹 110 批的方案 L3-group-panel-fullscreen.md):
 * the same three forms, what a page says about itself kept by page in the one store the session page reads, the toolbar and
 * menu read as the session page reads them. Only where each is drawn differs.
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

const slot = (props: Partial<ComponentProps<typeof GroupAppSlot>> = {}) =>
  createElement(GroupAppSlot, { chatId: 'group-1', kind: WORKSPACE_APP_KIND, title: 'Workspace', onClose: vi.fn(), ...props })
const fullSwitch = () => harness.container.querySelector<HTMLButtonElement>('[data-testid="group-app-slot-full"]')
const NONE: { id: string; title: string }[] = []

describe('the form of a group panel (摩擦单 F29: as it was left in each group, full too)', () => {
  it('is kept per group; a file asked for opens a closed panel beside the messages and leaves a full one full', () => {
    expect(groupSlotMemory.form('form-a')).toBe('closed')
    groupSlotMemory.setForm('form-a', 'full')
    groupSlotMemory.setForm('form-b', 'side')
    expect([groupSlotMemory.form('form-a'), groupSlotMemory.form('form-b')]).toEqual(['full', 'side'])

    groupSlotMemory.askFile('form-a', 'item-1')
    groupSlotMemory.askFile('form-c', 'item-2')
    expect([groupSlotMemory.form('form-a'), groupSlotMemory.form('form-c')]).toEqual(['full', 'side'])

    groupSlotMemory.setOpened('form-a', null)
    expect(groupSlotMemory.form('form-a')).toBe('full')
  })
})

describe('the slot header', () => {
  it('has the full switch where the panel can go full, pressed while full; a topic slot (no switch given) has none', async () => {
    const onToggleFull = vi.fn()
    await harness.render(slot({ full: false, onToggleFull }))
    expect(fullSwitch()?.getAttribute('aria-pressed')).toBe('false')
    expect(fullSwitch()?.getAttribute('aria-label')).toBe('面板全屏')
    act(() => fullSwitch()!.click())
    expect(onToggleFull).toHaveBeenCalledTimes(1)

    await harness.render(slot({ full: true, onToggleFull }))
    expect(fullSwitch()?.getAttribute('aria-pressed')).toBe('true')
    expect(fullSwitch()?.getAttribute('aria-label')).toBe('还原面板')

    await harness.render(slot())
    expect(fullSwitch()).toBeNull()
  })

  it('draws what its page says about itself as main hands it to a task’s tab (L11 复核 11): one store, one rule', async () => {
    // On screen, the slot claims its page (the events the resident layer listens to); main's relay then reaches the
    // renderer's host-action handler, which is `extensionSurfaceStore.say` with the slot's tab and no task.
    const stop = listenForAppSlots()
    HTMLElement.prototype.checkVisibility = () => true
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 360, bottom: 400, width: 360, height: 400, toJSON: () => ({}) })
    try {
      await harness.render(slot({ chatId: 'group-2' }))
      const claimOf = (chatId: string, itemId?: string) =>
        [...extensionViewStore.claims.values(), ...[...extensionViewStore.filePages.values()].map((file) => file.claim)].find(
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
      groupSlotMemory.setOpened('group-4', { kind: WORKSPACE_APP_KIND, itemId: 'item-4', title: 'Workspace', typedName: 'plan.json', opening: 4 })
      // (Its page waits for the group's shared packages to be read — a signed-in person's.)
      await harness.render(createElement(AuthContext.Provider, { value: { user: { id: 'user-1' } } as never }, slot({ chatId: 'group-4' })))
      await act(async () => {})
      act(() => extensionSurfaceStore.say(null, claimOf('group-4', 'item-4').tabId, { title: 'plan.json · Board' }))
      expect(harness.container.textContent).toContain('plan.json · Board')
      expect(extensionSurfaceStore.sharedState(residentPageKey(WORKSPACE_APP_KIND, residentPlace({ chatId: 'group-4' }))).title).toBeNull()
    } finally {
      stop()
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
    await harness.render(slot({ kind: 'board.main' }))
    const inline = () => [...harness.container.querySelectorAll('[data-command]')].map((node) => node.getAttribute('data-command'))
    expect(inline()).toEqual(['add', 'sort'])
    expect(harness.container.querySelector('[data-testid="group-app-slot-more"]')).not.toBeNull()

    install([{ id: 'add', title: 'Add' }], [])
    expect(inline()).toEqual(['add'])
    expect(harness.container.querySelector('[data-testid="group-app-slot-more"]')).toBeNull()
  })

  it('reads what is installed straight from the store: the update bar and the 「no page」 note follow it', async () => {
    install([], [], '1.0.0')
    sharedHere.packages = new Map([['board', { manifest: { id: 'board', name: 'Board', version: '1.1.0' }, card: { source: { kind: 'url', url: 'https://files.invalid/board.zip' }, messageId: 'm-board' } }]])
    await harness.render(
      createElement(AuthContext.Provider, { value: { user: { id: 'user-1' } } as never }, slot({ chatId: 'group-3', kind: 'board.main' })),
    )
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
    await harness.render(
      createElement(AuthContext.Provider, { value: { user: { id: 'user-1' } } as never }, slot({ chatId: 'group-3', kind: 'board.main' })),
    )
    await act(async () => {})
    expect(harness.container.querySelector('[data-testid="group-app-slot"]')).not.toBeNull()
    expect(harness.container.querySelector('[data-testid="group-app-slot-update"]')).toBeNull()
  })
})

// 「在本群打开」(app-redesign §5, 统筹 10-05): an App with a page of its own opens that page in the group's panel, the group
// its context; an App that only opens files opens where its files are (摩擦单 F51). Control (the parent commit): every App
// went to its files — one with none opened nothing at all.
describe('an App opened in the group (「在本群打开」)', () => {
  const installTabs = (tabs: { name: string; title: string; opensFiles?: Record<string, string[]> }[]) =>
    act(() => installedExtensionsStore.applyList({ extensions: [{ id: 'board', name: 'Board', version: '1.0.0', contributes: { tabs } }], invalid: [] } as unknown as InstalledExtensionsList))

  it('opens its own page here, with no file', async () => {
    const { appsHere } = await import('../../../../apps/desktop/src/components/appSlot/appsHere')
    vi.mocked(appsHere!.groupFilesOpenedBy).mockClear()
    installTabs([{ name: 'main', title: 'Board' }])
    await harness.render(slot({ chatId: 'group-5', appToOpen: { chatId: 'group-5', extensionId: 'board', request: 5001 } }))
    await act(async () => {})
    expect(groupSlotMemory.opened('group-5')).toMatchObject({ kind: 'board.main', title: 'Board' })
    expect(groupSlotMemory.opened('group-5')?.itemId).toBeUndefined()
    expect(appsHere!.groupFilesOpenedBy).not.toHaveBeenCalled()
  })

  // App 引用 pill: the place a pill points at goes with the file to whoever resolves who opens it (main on the desktop,
  // the phone's host there) — that is where the App that opens it is told, as the `link` event a gugu link brings.
  it('a file asked for at a place: the place goes to the host that resolves who opens it', async () => {
    const { appsHere } = await import('../../../../apps/desktop/src/components/appSlot/appsHere')
    vi.mocked(appsHere!.groupFileOpener).mockClear()
    vi.mocked(appsHere!.groupFileOpener).mockResolvedValue({ success: false, error: 'not in this test' })
    groupSlotMemory.askFile('group-7', 'item-7', { slide: '3', shape: '12' })
    const asked = groupSlotMemory.takeFile('group-7')
    expect(asked).toEqual({ itemId: 'item-7', at: { slide: '3', shape: '12' } })
    expect(groupSlotMemory.takeFile('group-7')).toBeNull()
    await harness.render(slot({ chatId: 'group-7', fileToOpen: { chatId: 'group-7', ...asked!, request: 7001 } }))
    await act(async () => {})
    expect(appsHere!.groupFileOpener).toHaveBeenCalledWith({ chatId: 'group-7', itemId: 'item-7', at: { slide: '3', shape: '12' } })
    // Control: a plain link's file goes without one.
    vi.mocked(appsHere!.groupFileOpener).mockClear()
    await harness.render(slot({ chatId: 'group-8', fileToOpen: { chatId: 'group-8', itemId: 'item-8', request: 8001 } }))
    await act(async () => {})
    expect(appsHere!.groupFileOpener).toHaveBeenCalledWith({ chatId: 'group-8', itemId: 'item-8' })
  })

  it('an App of files only goes to its files', async () => {
    const { appsHere } = await import('../../../../apps/desktop/src/components/appSlot/appsHere')
    vi.mocked(appsHere!.groupFilesOpenedBy).mockClear()
    installTabs([{ name: 'main', title: 'Board', opensFiles: { chat: ['.board.json'] } }])
    await harness.render(slot({ chatId: 'group-6', appToOpen: { chatId: 'group-6', extensionId: 'board', request: 6001 } }))
    await act(async () => {})
    expect(appsHere!.groupFilesOpenedBy).toHaveBeenCalledWith({ chatId: 'group-6', extensionId: 'board' })
    expect(groupSlotMemory.opened('group-6')).toBeNull()
  })
})
