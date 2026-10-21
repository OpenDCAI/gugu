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
 * #7257 (review 5): the panel offers the App for a file nobody here opens (F, deck.pptx); 「安装」 is pressed, and while it
 * installs the person clicks another pill (G). Pressing 「安装」 is the ask for F, so G — asked after — is the one the panel
 * ends on, whichever answer comes back first. Control: nothing asked meanwhile, F opens once its App is in. The harness
 * is groupPanelMarketOffer.test.tsx's; the install's answer and G's are held and let go in either order.
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
    marketOffers: vi.fn(async () => ({ success: true, data: [{ manifest: slides('1.2.0'), version: '1.2.0' }] })),
    groupFileOpener: vi.fn(),
    groupFilesOpenedBy: vi.fn(async () => ({ success: true, data: [] })),
    setOpenWithDefault: vi.fn(),
  },
}))
vi.mock('../../../../apps/desktop/src/components/extensionBundle/sharedPackages', () => ({
  sharedPackagesOf: async () => new Map(),
  subscribeSharedPackages: () => () => {},
}))
const { appsHere } = await import('../../../../apps/desktop/src/components/appSlot/appsHere')

function slides(version: string) {
  return { id: 'slides', name: 'Slides', version, apiVersion: 4, entry: 'index.html', contributes: { tabs: [{ name: 'main', title: 'Slides', opensFiles: { chat: ['.pptx'] } }] } }
}
const install = (manifests: unknown[]) =>
  act(() => installedExtensionsStore.applyList({ extensions: manifests, invalid: [] } as unknown as InstalledExtensionsList))

let harness: ReturnType<typeof createReactHarness>
const originalCheckVisibility = HTMLElement.prototype.checkVisibility
/** Held answers: G's open, and the install. */
let gates: Map<string, () => void>
beforeEach(() => {
  harness = createReactHarness()
  HTMLElement.prototype.checkVisibility = () => false
  install([])
  gates = new Map()
  vi.mocked(appsHere!.groupFileOpener).mockReset()
  vi.mocked(appsHere!.installFromMarket).mockReset()
  // F (item-f, deck.pptx): nobody opens it until Slides is in — answered at once. G (item-g): Notes opens it — held.
  vi.mocked(appsHere!.groupFileOpener).mockImplementation((args: { chatId: string; itemId: string }) => {
    if (args.itemId === 'item-g') {
      const candidate = { extensionId: 'notes', app: { name: 'Notes' }, tabKind: 'notes.main', tabTitle: 'Notes', suffix: '.md', onlyTab: true }
      return new Promise((resolve) => gates.set('G', () => resolve({ success: true, data: { chatId: args.chatId, itemId: 'item-g', name: 'g.md', typedName: 'g.md', choice: { kind: 'one', candidate } } } as never)))
    }
    const installed = installedExtensionsStore.manifests.some((manifest) => manifest.id === 'slides')
    const candidate = { extensionId: 'slides', app: { name: 'Slides' }, tabKind: 'slides.main', tabTitle: 'Slides', suffix: '.pptx', onlyTab: true }
    return Promise.resolve({ success: true, data: { chatId: args.chatId, itemId: 'item-f', name: 'deck.pptx', typedName: 'deck.pptx', choice: installed ? { kind: 'one', candidate } : { kind: 'none' } } } as never)
  })
  vi.mocked(appsHere!.installFromMarket).mockImplementation(
    () =>
      new Promise((resolve) =>
        gates.set('install', () => {
          install([slides('1.2.0')])
          resolve({ success: true, data: { installed: true, outcome: 'confirmed', id: 'slides', name: 'Slides', version: '1.2.0' } } as never)
        }),
      ),
  )
})
afterEach(() => {
  harness.cleanup()
  HTMLElement.prototype.checkVisibility = originalCheckVisibility
})

/** A task boundary: every microtask the answer let go has run (not a wall-clock wait). */
const settled = () => new Promise<void>((done) => setTimeout(done, 0))
const offer = () => harness.container.querySelector<HTMLElement>('[data-testid="group-app-slot-offer"]')
const on = (chatId: string) => groupSlotMemory.opened(chatId)?.itemId ?? null
const panel = (chatId: string, itemId: string, request: number) =>
  harness.render(
    createElement(AuthContext.Provider, { value: { user: { id: 'user-1' } } as never },
      createElement(GroupAppSlot, { chatId, kind: WORKSPACE_APP_KIND, title: 'Workspace', onClose: vi.fn(), fileToOpen: { chatId, itemId, request } })),
  )
/** F asked for, the panel offers Slides for it, 「安装」 pressed: the install on its way. */
async function offeredAndPressed(chatId: string, request: number) {
  await panel(chatId, 'item-f', request)
  await until('the panel offers Slides for F', () => offer() !== null)
  await act(async () => harness.container.querySelector<HTMLButtonElement>('[data-testid="group-app-slot-offer-install"]')!.click())
  await until('the install is on its way', () => gates.has('install'))
}
async function clickG(chatId: string, request: number) {
  await panel(chatId, 'item-g', request)
  await until('G is asked of the host', () => gates.has('G'))
}
const letGo = (name: string) =>
  act(async () => {
    gates.get(name)!()
    await settled()
  })

describe('an App installed for a file, and another pill clicked while it installs: the later ask wins (#7257)', () => {
  it('G answered, then the install done: G stays — F does not take the panel back', async () => {
    await offeredAndPressed('offer-1', 7_257_101)
    await clickG('offer-1', 7_257_102)
    await letGo('G')
    expect(on('offer-1')).toBe('item-g')
    await letGo('install')
    await settled()
    expect(on('offer-1'), '对照:#7275 原本装完又把面板抢回 F').toBe('item-g')
  }, 60_000)

  it('the install done, then G answered: G — the install does not open F over the later ask', async () => {
    await offeredAndPressed('offer-2', 7_257_111)
    await clickG('offer-2', 7_257_112)
    await letGo('install')
    await settled()
    expect(on('offer-2'), 'F is not opened: G was asked after 「安装」').toBe(null)
    await letGo('G')
    expect(on('offer-2'), '对照:524a00eb92 装完才取序号，停在 F,G 被丢').toBe('item-g')
  }, 60_000)

  it('control: nothing asked while it installs — F opens in the App just installed', async () => {
    await offeredAndPressed('offer-3', 7_257_121)
    await letGo('install')
    await until('F opened in Slides', () => groupSlotMemory.opened('offer-3')?.kind === 'slides.main')
    expect(on('offer-3')).toBe('item-f')
  }, 60_000)
})
