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
 * 161 10-16 (review of the switch): the panel says the App for a file nobody here opens (F, deck.pptx) is installed but
 * switched off; 「启用」 is pressed, and while it switches on the person clicks another pill (G). Pressing 「启用」 is the ask
 * for F, as 「安装」 is (#7257), so G — asked after — is the one the panel ends on, whichever answer comes back first.
 * Control: nothing asked meanwhile, F opens once its App is on. The harness is groupPanelOfferLastAsk7257.test.tsx's, the
 * switched-off App groupPanelMarketOffer.test.tsx's; the switch's answer and G's are held and let go in either order.
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
const { appsHere } = await import('../../../../apps/desktop/src/components/appSlot/appsHere')

function slides() {
  return { id: 'slides', name: 'Slides', version: '1.2.0', apiVersion: 4, entry: 'index.html', contributes: { tabs: [{ name: 'main', title: 'Slides', opensFiles: { chat: ['.pptx'] } }] } }
}
/** Slides installed here; `disabled` names it when it is switched off. */
const list = (disabled: string[]) =>
  act(() => installedExtensionsStore.applyList({ extensions: [slides()], invalid: [], disabled } as unknown as InstalledExtensionsList))

let harness: ReturnType<typeof createReactHarness>
const originalCheckVisibility = HTMLElement.prototype.checkVisibility
/** Held answers: G's open, and the switch. */
let gates: Map<string, () => void>
beforeEach(() => {
  harness = createReactHarness()
  HTMLElement.prototype.checkVisibility = () => false
  list(['slides'])
  gates = new Map()
  vi.mocked(appsHere!.groupFileOpener).mockReset()
  vi.mocked(appsHere!.setEnabled).mockReset()
  // F (item-f, deck.pptx): nobody opens it while Slides is off — answered at once. G (item-g): Notes opens it — held.
  vi.mocked(appsHere!.groupFileOpener).mockImplementation((args: { chatId: string; itemId: string }) => {
    if (args.itemId === 'item-g') {
      const candidate = { extensionId: 'notes', app: { name: 'Notes' }, tabKind: 'notes.main', tabTitle: 'Notes', suffix: '.md', onlyTab: true }
      return new Promise((resolve) => gates.set('G', () => resolve({ success: true, data: { chatId: args.chatId, itemId: 'item-g', name: 'g.md', typedName: 'g.md', choice: { kind: 'one', candidate } } } as never)))
    }
    const on = installedExtensionsStore.isEnabled('slides')
    const candidate = { extensionId: 'slides', app: { name: 'Slides' }, tabKind: 'slides.main', tabTitle: 'Slides', suffix: '.pptx', onlyTab: true }
    return Promise.resolve({ success: true, data: { chatId: args.chatId, itemId: 'item-f', name: 'deck.pptx', typedName: 'deck.pptx', choice: on ? { kind: 'one', candidate } : { kind: 'none' } } } as never)
  })
  vi.mocked(appsHere!.setEnabled).mockImplementation(
    () =>
      new Promise((resolve) =>
        gates.set('switch', () => {
          list([])
          resolve({ success: true })
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
const switchedOff = () => harness.container.querySelector<HTMLElement>('[data-testid="group-app-slot-switched-off"]')
const on = (chatId: string) => groupSlotMemory.opened(chatId)?.itemId ?? null
const panel = (chatId: string, itemId: string, request: number) =>
  harness.render(
    createElement(AuthContext.Provider, { value: { user: { id: 'user-1' } } as never },
      createElement(GroupAppSlot, { chatId, kind: WORKSPACE_APP_KIND, title: 'Workspace', onClose: vi.fn(), fileToOpen: { chatId, itemId, request } })),
  )
/** F asked for, the panel says Slides is off, 「启用」 pressed: the switch on its way. */
async function offAndPressed(chatId: string, request: number) {
  await panel(chatId, 'item-f', request)
  await until('the panel says Slides is switched off for F', () => switchedOff() !== null)
  await act(async () => harness.container.querySelector<HTMLButtonElement>('[data-testid="group-app-slot-switch-on"]')!.click())
  await until('the switch is on its way', () => gates.has('switch'))
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

describe('an App switched on for a file, and another pill clicked while it switches on: the later ask wins', () => {
  it('G answered, then the switch done: G stays — F does not take the panel back', async () => {
    await offAndPressed('switch-1', 7_280_101)
    await clickG('switch-1', 7_280_102)
    await letGo('G')
    expect(on('switch-1')).toBe('item-g')
    await letGo('switch')
    await settled()
    expect(on('switch-1'), '对照:c3c408365b 启用好了又把面板抢回 F').toBe('item-g')
  }, 60_000)

  it('the switch done, then G answered: G — switching on does not open F over the later ask', async () => {
    await offAndPressed('switch-2', 7_280_111)
    await clickG('switch-2', 7_280_112)
    await letGo('switch')
    await settled()
    expect(on('switch-2'), 'F is not opened: G was asked after 「启用」').toBe(null)
    await letGo('G')
    expect(on('switch-2'), '对照:c3c408365b 启用好了才取序号，停在 F,G 被丢').toBe('item-g')
  }, 60_000)

  it('control: nothing asked while it switches on — F opens in the App just switched on', async () => {
    await offAndPressed('switch-3', 7_280_121)
    await letGo('switch')
    await until('F opened in Slides', () => groupSlotMemory.opened('switch-3')?.kind === 'slides.main')
    expect(on('switch-3')).toBe('item-f')
  }, 60_000)
})
