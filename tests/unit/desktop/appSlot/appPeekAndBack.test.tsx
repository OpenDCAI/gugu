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

const { GroupAppSlot, WORKSPACE_APP_KIND } = await import('../../../../apps/desktop/src/components/appSlot/GroupAppSlot')
const { groupSlotMemory } = await import('../../../../apps/desktop/src/components/appSlot/groupSlotMemory')
const { AppPeekSlot } = await import('../../../../apps/desktop/src/components/appSlot/AppPeekSlot')
const { ClaimedPage } = await import('../../../../apps/desktop/src/components/appSlot/ClaimedPage')
const { peekStore } = await import('../../../../apps/desktop/src/session/renderer/features/extensions/peek-store')
const { installedExtensionsStore } = await import('../../../../apps/desktop/src/session/renderer/features/extensions/installed-extensions-store')
const { APP_SLOT_EVENT } = await import('../../../../apps/desktop/src/session/shared/extensions/app-runtime-protocol')
const { AuthContext } = await import('../../../../apps/desktop/src/store/auth')

const board = { id: 'kanban', name: 'Kanban', version: '1.0.0', apiVersion: 3, entry: 'index.html', contributes: { tabs: [{ name: 'board', title: 'Kanban' }] } }
const pdf = { extensionId: 'pdf', tabKind: 'pdf.viewer', tabTitle: 'PDF', app: { name: 'PDF' }, onlyTab: true, suffix: '.pdf' }

let harness: ReturnType<typeof createReactHarness>
const slotEvents: { type: string; slotId: string }[] = []
const onSlot = (event: Event) => {
  const { type, slotId } = (event as CustomEvent<{ type: string; slotId: string }>).detail
  slotEvents.push({ type, slotId })
}
const original = { checkVisibility: HTMLElement.prototype.checkVisibility, rect: HTMLElement.prototype.getBoundingClientRect }
beforeEach(() => {
  harness = createReactHarness()
  slotEvents.length = 0
  window.addEventListener(APP_SLOT_EVENT, onSlot)
  // Seen while no ancestor hides it (what the browser answers), at a panel's size.
  HTMLElement.prototype.checkVisibility = function (this: HTMLElement) {
    return !this.closest('.invisible')
  }
  HTMLElement.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 520, bottom: 800, width: 520, height: 800, toJSON: () => ({}) })
  act(() => installedExtensionsStore.applyList({ extensions: [board], invalid: [] } as never))
})
afterEach(() => {
  harness.cleanup()
  window.removeEventListener(APP_SLOT_EVENT, onSlot)
  HTMLElement.prototype.checkVisibility = original.checkVisibility
  HTMLElement.prototype.getBoundingClientRect = original.rect
  act(() => installedExtensionsStore.applyList({ extensions: [], invalid: [] } as never))
})

describe('G2: back from a file opened by an App goes back to that App', () => {
  it('the App, then a file it opened, then back: the App again — and back once more: the folder', async () => {
    const chatId = 'back-1'
    const slot = (props: Record<string, unknown>) =>
      createElement(AuthContext.Provider, { value: { user: { id: 'user-1' } } as never },
        createElement(GroupAppSlot, { chatId, kind: WORKSPACE_APP_KIND, title: 'Workspace', onClose: vi.fn(), ...props }))
    await harness.render(slot({ appToOpen: { chatId, extensionId: 'kanban', request: 9101 } }))
    expect(groupSlotMemory.opened(chatId)?.kind).toBe('kanban.board')
    const opener = { chatId, itemId: 'deck', name: 'deck.pdf', typedName: 'deck.pdf', choice: { kind: 'one', candidate: pdf } }
    await harness.render(slot({ fileToOpen: { chatId, itemId: 'deck', request: 9102, opener } }))
    expect(groupSlotMemory.opened(chatId)).toMatchObject({ kind: 'pdf.viewer', itemId: 'deck' })
    act(() => (harness.container.querySelector('[data-testid="group-app-slot-back"]') as HTMLButtonElement).click())
    expect(groupSlotMemory.opened(chatId)?.kind, '对照:父提交回到文件夹(null)').toBe('kanban.board')
    act(() => (harness.container.querySelector('[data-testid="group-app-slot-back"]') as HTMLButtonElement).click())
    expect(groupSlotMemory.opened(chatId)).toBeNull()
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
      peekStore.open(null, 'slot-y', { kind: 'local', place: { session: 's-1' }, projectId: 'p-1', workspaceId: 'w-1', path: 'docs/blob.zip', absolutePath: '/work/docs/blob.zip', name: 'blob.zip', ask: false })
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
