// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ComponentProps } from 'react'
import { createReactHarness } from '../../../support/testHarness'
import { until } from '../../../support/awaitCondition'
import { GroupAppSlot, WORKSPACE_APP_KIND } from '../../../../apps/desktop/src/components/appSlot/GroupAppSlot'
import { groupSlotMemory } from '../../../../apps/desktop/src/components/appSlot/groupSlotMemory'
import { appsHere } from '../../../../apps/desktop/src/components/appSlot/appsHere'
import { APP_OPEN_WITH_EVENT } from '../../../../apps/desktop/src/session/shared/extensions/app-runtime-protocol'
import { AuthContext } from '../../../../apps/desktop/src/store/auth'

/**
 * #7257 (review 2, point 5): the file a group's panel ends on is the one asked last. Two pills clicked one after the other
 * (A, then B), each answered by the host when the test lets it go — in either order: the panel ends on B. So too when the
 * later ask is a file clicked in an App's list (`files.openWith`, its answer already in hand). The harness is
 * groupPanelOneModel.test.tsx's; the host's answers are held open.
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

let harness: ReturnType<typeof createReactHarness>
const originalCheckVisibility = HTMLElement.prototype.checkVisibility
beforeEach(() => {
  harness = createReactHarness()
  HTMLElement.prototype.checkVisibility = () => false
})
afterEach(() => {
  harness.cleanup()
  HTMLElement.prototype.checkVisibility = originalCheckVisibility
})

const detailOf = (chatId: string, itemId: string) => ({
  chatId, itemId, name: `${itemId}.pptx`, typedName: `${itemId}.pptx`,
  choice: { kind: 'one', candidate: { extensionId: 'office', tabKind: 'office.main', tabTitle: 'Office', app: { name: '咕咕办公' }, onlyTab: true, claim: '.pptx' } },
})
const slot = (props: Partial<ComponentProps<typeof GroupAppSlot>>) =>
  createElement(AuthContext.Provider, { value: { user: { id: 'user-1' } } as never },
    createElement(GroupAppSlot, { chatId: 'race', kind: WORKSPACE_APP_KIND, title: 'Workspace', onClose: vi.fn(), ...props }))
const unopened = () => harness.container.querySelector('[data-testid="group-app-slot-unopened"]')?.textContent ?? null
/** A task boundary: every microtask the answer let go has run (not a wall-clock wait). */
const settled = () => new Promise<void>((done) => setTimeout(done, 0))

let request = 7257_000
/** The host's answers, held until the test lets each go: `fail` answers it as the host's error. */
function holdAnswers() {
  const gates = new Map<string, (fail?: string) => void>()
  vi.mocked(appsHere!.groupFileOpener).mockImplementation(
    (args: { chatId: string; itemId: string }) =>
      new Promise((resolve) => gates.set(args.itemId, (fail) => resolve((fail ? { success: false, error: fail } : { success: true, data: detailOf(args.chatId, args.itemId) }) as never))),
  )
  return gates
}
async function clickPill(chatId: string, itemId: string, gates: Map<string, unknown>) {
  await harness.render(slot({ chatId, fileToOpen: { chatId, itemId, request: ++request, at: { slide: '1' } } }))
  await until(`${itemId} is asked of the host`, () => gates.has(itemId))
}
async function letGo(gates: Map<string, (fail?: string) => void>, itemId: string, fail?: string) {
  await act(async () => {
    gates.get(itemId)!(fail)
    await settled()
  })
}

describe('two pills clicked one after the other: the panel ends on the second (#7257)', () => {
  it('B answered first, then A (A\'s read was slower): B', async () => {
    const gates = holdAnswers()
    await clickPill('race-1', 'A', gates)
    await clickPill('race-1', 'B', gates)
    await letGo(gates, 'B')
    await until('the panel took B', () => groupSlotMemory.opened('race-1')?.itemId === 'B')
    await letGo(gates, 'A')
    expect(groupSlotMemory.opened('race-1')?.itemId, '对照:父提交在 A 的回答晚到时停在 A 上').toBe('B')
  }, 30_000)

  it('A answered first, then B: A is no longer the latest ask by then — not shown; B', async () => {
    const gates = holdAnswers()
    await clickPill('race-2', 'A', gates)
    await clickPill('race-2', 'B', gates)
    await letGo(gates, 'A')
    expect(groupSlotMemory.opened('race-2')?.itemId ?? null, 'A is not the latest ask: its answer is not shown').toBe(null)
    await letGo(gates, 'B')
    expect(groupSlotMemory.opened('race-2')?.itemId).toBe('B')
  }, 30_000)

  it('the earlier one failing late says nothing over the later one', async () => {
    const gates = holdAnswers()
    await clickPill('race-3', 'A', gates)
    await clickPill('race-3', 'B', gates)
    await letGo(gates, 'B')
    await until('the panel took B', () => groupSlotMemory.opened('race-3')?.itemId === 'B')
    await letGo(gates, 'A', 'the file is gone')
    expect(unopened()).toBe(null)
    expect(groupSlotMemory.opened('race-3')?.itemId).toBe('B')
  }, 30_000)

  // A file clicked in an App's list comes as the chat shell hands it (MainLayout: its chat up, the host's answer with it).
  it('a pill, then a file clicked in an App\'s list: the App\'s file, whatever the pill\'s answer does later', async () => {
    const gates = holdAnswers()
    await clickPill('race-4', 'A', gates)
    await harness.render(slot({ chatId: 'race-4', fileToOpen: { chatId: 'race-4', itemId: 'Y', request: ++request, opener: detailOf('race-4', 'Y') as never } }))
    expect(groupSlotMemory.opened('race-4')?.itemId).toBe('Y')
    expect(vi.mocked(appsHere!.groupFileOpener).mock.calls.some(([args]) => (args as { itemId: string }).itemId === 'Y'), 'answered already: not asked of the host again').toBe(false)
    await letGo(gates, 'A')
    expect(groupSlotMemory.opened('race-4')?.itemId).toBe('Y')
  }, 30_000)

  // The open-with event is the chat shell's (MainLayout), not a panel's: another chat's App answering opens nothing here.
  it('a pill waiting, then another chat\'s App answers: the pill still opens', async () => {
    const gates = holdAnswers()
    await clickPill('race-5', 'P', gates)
    await act(async () => {
      window.dispatchEvent(new CustomEvent(APP_OPEN_WITH_EVENT, { detail: detailOf('another-chat', 'Z') }))
    })
    expect(groupSlotMemory.opened('race-5')?.itemId ?? null, 'another chat\'s file is not opened here').toBe(null)
    await letGo(gates, 'P')
    expect(groupSlotMemory.opened('race-5')?.itemId, '对照:11bd96dbf5 先加序号再核群,P 被丢，面板什么都不开').toBe('P')
  }, 30_000)
})
