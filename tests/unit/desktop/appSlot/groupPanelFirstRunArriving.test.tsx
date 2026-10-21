// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createReactHarness } from '../../../support/testHarness'
import { until } from '../../../support/awaitCondition'
import { GroupAppSlot, WORKSPACE_APP_KIND } from '../../../../apps/desktop/src/components/appSlot/GroupAppSlot'
import { groupSlotMemory } from '../../../../apps/desktop/src/components/appSlot/groupSlotMemory'
import { installedExtensionsStore, type InstalledExtensionsList } from '../../../../apps/desktop/src/session/renderer/features/extensions/installed-extensions-store'
import { AuthContext } from '../../../../apps/desktop/src/store/auth'

/**
 * 161 10-16 (owner「只要保证初次用户体验稳定就行」): a new person signs in and opens a deck in the group's folder while 咕咕办公
 * (here: Slides), one of the first-run set, is still coming down. The panel must not say 「no App opens it」 nor offer to
 * install it: it says Slides is being set up, and opens the file in it once it is in — unless something else was asked
 * meanwhile. One that did not go in this time (offline) is tried again at once, the file being the reason, then said to
 * wait, with 「再试一次」. Control (the parent commit c3c408365b): the market's offer 「安装」, as for any App not here.
 */
vi.mock('../../../../apps/desktop/src/platform', () => ({
  platform: { kind: 'electron', capabilities: { appUpdates: false, notifications: false, rendererCommandBridge: false } },
}))
vi.mock('../../../../apps/desktop/src/components/appSlot/appsHere', () => ({
  appsHere: {
    runs: () => true,
    grantable: (manifest: unknown) => manifest,
    installAttachment: vi.fn(),
    installFromMarket: vi.fn(),
    marketOffers: vi.fn(async () => ({ success: true, data: [{ manifest: slides(), version: '1.2.0' }] })),
    groupFileOpener: vi.fn(),
    groupFilesOpenedBy: vi.fn(async () => ({ success: true, data: [] })),
    setOpenWithDefault: vi.fn(),
    setEnabled: vi.fn(),
  },
}))
vi.mock('../../../../apps/desktop/src/components/extensionBundle/sharedPackages', () => ({
  sharedPackagesOf: async () => new Map(),
  subscribeSharedPackages: () => () => {},
}))
// What main says is on its way, and its 「try again」 (firstRunApps.ts): an observable list the test sets, a held retry.
vi.mock('../../../../apps/desktop/src/components/appSlot/firstRunApps', async () => {
  const { makeAutoObservable } = await import('mobx')
  const firstRunArrivals = makeAutoObservable({
    apps: [] as { manifest: unknown; installing: boolean }[],
    pending: false,
    set(state: { apps: { manifest: unknown; installing: boolean }[]; pending: boolean }) {
      this.apps = state.apps
      this.pending = state.pending
    },
  })
  return { firstRunArrivals, retryFirstRun: vi.fn(async () => {}) }
})
const { appsHere } = await import('../../../../apps/desktop/src/components/appSlot/appsHere')
const { firstRunArrivals, retryFirstRun } = await import('../../../../apps/desktop/src/components/appSlot/firstRunApps')

function slides() {
  return { id: 'slides', name: 'Slides', version: '1.2.0', apiVersion: 4, entry: 'index.html', contributes: { tabs: [{ name: 'main', title: 'Slides', opensFiles: { chat: ['.pptx'] } }] } }
}
const install = (manifests: unknown[]) =>
  act(() => installedExtensionsStore.applyList({ extensions: manifests, invalid: [] } as unknown as InstalledExtensionsList))
const onTheWay = (installing: boolean) => act(() => firstRunArrivals.set({ apps: [{ manifest: slides(), installing }], pending: true } as never))
/** All of the set in: nothing on its way, nothing left to do. */
const allIn = () => act(() => firstRunArrivals.set({ apps: [], pending: false }))

let harness: ReturnType<typeof createReactHarness>
const originalCheckVisibility = HTMLElement.prototype.checkVisibility
let gates: Map<string, () => void>
/** F's answer once Slides is in, held (the moment the host takes to say who opens it). */
let holdF = false
beforeEach(() => {
  holdF = false
  harness = createReactHarness()
  HTMLElement.prototype.checkVisibility = () => false
  install([])
  allIn()
  gates = new Map()
  vi.mocked(retryFirstRun).mockReset()
  vi.mocked(retryFirstRun).mockImplementation(async () => {})
  vi.mocked(appsHere!.groupFileOpener).mockReset()
  // F (item-f, deck.pptx): nobody opens it until Slides is in. G (item-g): Notes opens it — held.
  vi.mocked(appsHere!.groupFileOpener).mockImplementation((args: { chatId: string; itemId: string }) => {
    if (args.itemId === 'item-g') {
      const candidate = { extensionId: 'notes', app: { name: 'Notes' }, tabKind: 'notes.main', tabTitle: 'Notes', suffix: '.md', onlyTab: true }
      return new Promise((resolve) => gates.set('G', () => resolve({ success: true, data: { chatId: args.chatId, itemId: 'item-g', name: 'g.md', typedName: 'g.md', choice: { kind: 'one', candidate } } } as never)))
    }
    const here = installedExtensionsStore.manifests.some((manifest) => manifest.id === 'slides')
    const candidate = { extensionId: 'slides', app: { name: 'Slides' }, tabKind: 'slides.main', tabTitle: 'Slides', suffix: '.pptx', onlyTab: true }
    const answer = { success: true, data: { chatId: args.chatId, itemId: 'item-f', name: 'deck.pptx', typedName: 'deck.pptx', choice: here ? { kind: 'one', candidate } : { kind: 'none' } } } as never
    if (here && holdF) return new Promise((resolve) => gates.set('F', () => resolve(answer)))
    return Promise.resolve(answer)
  })
})
afterEach(() => {
  harness.cleanup()
  HTMLElement.prototype.checkVisibility = originalCheckVisibility
})

/** A task boundary: every microtask the answer let go has run (not a wall-clock wait). */
const settled = () => new Promise<void>((done) => setTimeout(done, 0))
const arriving = () => harness.container.querySelector<HTMLElement>('[data-testid="group-app-slot-arriving"]')
const offer = () => harness.container.querySelector<HTMLElement>('[data-testid="group-app-slot-offer"]')
const noOpener = () => harness.container.querySelector<HTMLElement>('[data-testid="group-app-slot-no-opener"]')
const on = (chatId: string) => groupSlotMemory.opened(chatId)?.itemId ?? null
const panel = (chatId: string, itemId: string, request: number) =>
  harness.render(
    createElement(AuthContext.Provider, { value: { user: { id: 'user-1' } } as never },
      createElement(GroupAppSlot, { chatId, kind: WORKSPACE_APP_KIND, title: 'Workspace', onClose: vi.fn(), fileToOpen: { chatId, itemId, request } })),
  )

describe('a file whose App of the first-run set is still on its way (161 10-16)', () => {
  it('said to be being set up — no 「no App opens it」, no offer to install — and opened in it the moment it is in', async () => {
    onTheWay(true)
    await panel('arrive-1', 'item-f', 7_280_201)
    await until('the panel says Slides is being set up', () => arriving() !== null)
    expect(arriving()?.textContent).toContain('用『Slides』打开')
    expect(arriving()?.textContent).toContain('『Slides』正在装好，装好马上在这里打开。')
    expect(arriving()?.dataset.installing).toBe('true')
    await settled()
    expect(offer(), 'the market lists Slides too: no 「安装」 beside its own install').toBeNull()
    expect(noOpener()).toBeNull()
    expect(harness.container.querySelector('[data-testid="group-app-slot-arriving-retry"]')).toBeNull()
    expect(retryFirstRun).not.toHaveBeenCalled()

    // Main says it left the way before this window has it among the installed: still 「being set up」, not an offer.
    allIn()
    await settled()
    expect(arriving()?.textContent).toContain('正在装好')
    expect(offer()).toBeNull()
    holdF = true
    install([slides()])
    await until('F asked of the host again, now Slides is in', () => gates.has('F'))
    await settled()
    expect(noOpener(), 'Slides is in, the file not open yet: not 「no App opens it」').toBeNull()
    expect(offer()).toBeNull()
    expect(arriving()?.textContent).toContain('正在装好')
    await act(async () => {
      gates.get('F')!()
      await settled()
    })
    await until('F opened in Slides', () => groupSlotMemory.opened('arrive-1')?.kind === 'slides.main')
    expect(on('arrive-1')).toBe('item-f')
    expect(arriving()).toBeNull()
    expect(appsHere!.installFromMarket).not.toHaveBeenCalled()
  }, 60_000)

  it('another pill clicked while it comes down, Slides in before G answers: G — Slides in does not open F over the later ask', async () => {
    onTheWay(true)
    await panel('arrive-2', 'item-f', 7_280_211)
    await until('the panel says Slides is being set up', () => arriving() !== null)
    await panel('arrive-2', 'item-g', 7_280_212)
    await until('G is asked of the host', () => gates.has('G'))
    allIn()
    install([slides()])
    await settled()
    expect(on('arrive-2'), 'F is not opened: G was asked after it').toBe(null)
    await act(async () => {
      gates.get('G')!()
      await settled()
    })
    expect(on('arrive-2')).toBe('item-g')
  }, 60_000)

  it('another pill clicked while it comes down, G answered first: G stays when Slides is in', async () => {
    onTheWay(true)
    await panel('arrive-5', 'item-f', 7_280_241)
    await until('the panel says Slides is being set up', () => arriving() !== null)
    await panel('arrive-5', 'item-g', 7_280_242)
    await until('G is asked of the host', () => gates.has('G'))
    await act(async () => {
      gates.get('G')!()
      await settled()
    })
    expect(on('arrive-5')).toBe('item-g')
    allIn()
    install([slides()])
    await settled()
    expect(on('arrive-5')).toBe('item-g')
  }, 60_000)

  it('it did not go in this time (offline): tried again at once — the file is the reason — then said to wait, with 「再试一次」', async () => {
    onTheWay(false)
    let release!: () => void
    vi.mocked(retryFirstRun).mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)))
    await panel('arrive-3', 'item-f', 7_280_221)
    await until('the panel says Slides is being set up', () => arriving() !== null)
    expect(retryFirstRun).toHaveBeenCalledTimes(1)
    expect(arriving()?.textContent, 'while the second go runs').toContain('正在装好')
    await act(async () => {
      release()
      await settled()
    })
    // That go did not get it either (main still says it waits): said, with a way to try again — once, not in a loop.
    expect(arriving()?.textContent).toContain('『Slides』还没装好：这次没能从下载站取到。')
    expect(retryFirstRun).toHaveBeenCalledTimes(1)
    await act(async () => harness.container.querySelector<HTMLButtonElement>('[data-testid="group-app-slot-arriving-retry"]')!.click())
    expect(retryFirstRun).toHaveBeenCalledTimes(2)
    expect(offer()).toBeNull()
  }, 60_000)

  it('the market not read yet (offline at the start), a file opened later: tried again at once, no offer meanwhile — then set up, and opened', async () => {
    act(() => firstRunArrivals.set({ apps: [], pending: true }))
    let release!: () => void
    vi.mocked(retryFirstRun).mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)))
    await panel('arrive-6', 'item-f', 7_280_251)
    await until('the first-run set is tried again', () => vi.mocked(retryFirstRun).mock.calls.length === 1)
    await settled()
    expect(offer(), 'the market lists Slides: no 「安装」 while that go reads the market').toBeNull()
    expect(noOpener()).toBeNull()
    // That go read the market: Slides is one of the set, coming down.
    onTheWay(true)
    await until('the panel says Slides is being set up', () => arriving() !== null)
    expect(offer()).toBeNull()
    await act(async () => {
      firstRunArrivals.set({ apps: [], pending: false })
      installedExtensionsStore.applyList({ extensions: [slides()], invalid: [] } as unknown as InstalledExtensionsList)
      release()
      await settled()
    })
    await until('F opened in Slides', () => groupSlotMemory.opened('arrive-6')?.kind === 'slides.main')
    expect(retryFirstRun).toHaveBeenCalledTimes(1)
  }, 60_000)

  it('control: that go finds the file\'s App is not one of the set — the market\'s offer, after it', async () => {
    act(() => firstRunArrivals.set({ apps: [], pending: true }))
    let release!: () => void
    vi.mocked(retryFirstRun).mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)))
    await panel('arrive-7', 'item-f', 7_280_261)
    await until('the first-run set is tried again', () => vi.mocked(retryFirstRun).mock.calls.length === 1)
    await act(async () => {
      firstRunArrivals.set({ apps: [], pending: false })
      release()
      await settled()
    })
    await until('the panel offers Slides', () => offer() !== null)
    expect(arriving()).toBeNull()
  }, 60_000)

  it('control: nothing of the first-run set on its way — the market\'s offer, as for any App not here', async () => {
    await panel('arrive-4', 'item-f', 7_280_231)
    await until('the panel offers Slides', () => offer() !== null)
    expect(arriving()).toBeNull()
    expect(retryFirstRun).not.toHaveBeenCalled()
  }, 60_000)
})
