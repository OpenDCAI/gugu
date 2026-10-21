// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createReactHarness } from '../../../support/testHarness'
import { GroupAppSlot, WORKSPACE_APP_KIND } from '../../../../apps/desktop/src/components/appSlot/GroupAppSlot'
import { groupSlotMemory } from '../../../../apps/desktop/src/components/appSlot/groupSlotMemory'
import { installedExtensionsStore, type InstalledExtensionsList } from '../../../../apps/desktop/src/session/renderer/features/extensions/installed-extensions-store'
import { AuthContext } from '../../../../apps/desktop/src/store/auth'
import { openerChoice } from '../../../../apps/desktop/src/session/shared/extensions/file-openers'
import type { ExtensionManifest } from '../../../../apps/desktop/src/session/shared/extensions/manifest'

/**
 * 161 10-15: a file of the group nobody on this device opens — the panel names the App that would and installs it in place,
 * then opens the file in it. One shared in this chat first (摩擦单 F15, the group's own), else the market's; desktop and
 * phone alike (the panel asks `appsHere`, which is main or the phone's store). Control (the parent commit): nobody here
 * opens it ⇒ `No App opens …` and the panel only said the file could not be opened.
 */

vi.mock('../../../../apps/desktop/src/platform', () => ({
  platform: { kind: 'electron', capabilities: { appUpdates: false, notifications: false, rendererCommandBridge: false } },
}))
const here = vi.hoisted(() => ({
  market: { success: true, data: [] } as { success: boolean; data?: unknown[]; error?: string },
}))
vi.mock('../../../../apps/desktop/src/components/appSlot/appsHere', () => ({
  appsHere: {
    runs: () => true,
    grantable: (manifest: unknown) => manifest,
    installAttachment: vi.fn(),
    installFromMarket: vi.fn(),
    marketOffers: vi.fn(async () => here.market),
    groupFileOpener: vi.fn(),
    groupFilesOpenedBy: vi.fn(async () => ({ success: true, data: [] })),
    setOpenWithDefault: vi.fn(),
    setEnabled: vi.fn(),
  },
}))
const sharedHere = vi.hoisted(() => ({ packages: new Map<string, unknown>() }))
vi.mock('../../../../apps/desktop/src/components/extensionBundle/sharedPackages', () => ({
  sharedPackagesOf: async () => sharedHere.packages,
  subscribeSharedPackages: () => () => {},
  packageKey: (card: { source: { kind: string; url?: string }; messageId: string }) => (card.source.kind === 'url' ? `url:${card.source.url}` : `msg:${card.messageId}`),
  installPackageOf: (card: { messageId: string }) => ({ messageId: card.messageId }),
}))
const { appsHere } = await import('../../../../apps/desktop/src/components/appSlot/appsHere')

const slides = (version: string) => ({
  id: 'slides',
  name: 'Slides',
  version,
  apiVersion: 4,
  entry: 'index.html',
  contributes: { tabs: [{ name: 'main', title: 'Slides', opensFiles: { chat: ['.pptx'] } }] },
})
const file = { chatId: 'group-1', itemId: 'item-1', name: 'deck.pptx', typedName: 'deck.pptx' }
const install = (manifests: unknown[]) =>
  act(() => installedExtensionsStore.applyList({ extensions: manifests, invalid: [] } as unknown as InstalledExtensionsList))

let harness: ReturnType<typeof createReactHarness>
const originalCheckVisibility = HTMLElement.prototype.checkVisibility
beforeEach(() => {
  harness = createReactHarness()
  HTMLElement.prototype.checkVisibility = () => false
  install([])
  sharedHere.packages = new Map()
  here.market = { success: true, data: [] }
  groupSlotMemory.setOpened('group-1', null)
  vi.mocked(appsHere!.marketOffers).mockClear()
  vi.mocked(appsHere!.installFromMarket).mockReset()
  vi.mocked(appsHere!.installAttachment).mockReset()
  vi.mocked(appsHere!.groupFileOpener).mockReset()
  // Nobody here opens it — until Slides is installed.
  vi.mocked(appsHere!.groupFileOpener).mockImplementation(async () => {
    const installed = installedExtensionsStore.manifests.some((manifest) => manifest.id === 'slides')
    const candidate = { extensionId: 'slides', app: { name: 'Slides' }, tabKind: 'slides.main', tabTitle: 'Slides', suffix: '.pptx', onlyTab: true }
    return { success: true, data: { ...file, choice: installed ? { kind: 'one', candidate } : { kind: 'none' } } } as never
  })
})
afterEach(() => {
  harness.cleanup()
  HTMLElement.prototype.checkVisibility = originalCheckVisibility
})

/** The panel with a link to the file asked for (摩擦单 F10): who opens it is the host's answer. */
async function openFile(request: number) {
  await harness.render(
    createElement(
      AuthContext.Provider,
      { value: { user: { id: 'user-1' } } as never },
      createElement(GroupAppSlot, { chatId: 'group-1', kind: WORKSPACE_APP_KIND, title: 'Workspace', onClose: vi.fn(), fileToOpen: { chatId: 'group-1', itemId: 'item-1', request } }),
    ),
  )
}
const offer = () => harness.container.querySelector<HTMLElement>('[data-testid="group-app-slot-offer"]')
const noOpener = () => harness.container.querySelector<HTMLElement>('[data-testid="group-app-slot-no-opener"]')
const switchedOff = () => harness.container.querySelector<HTMLElement>('[data-testid="group-app-slot-switched-off"]')
/** React and the pending answers flushed until `fact` holds — a bounded number of turns, never a clock; red names the step. */
async function until(step: string, fact: () => boolean) {
  for (let turn = 0; turn < 50 && !fact(); turn++) await act(async () => { await Promise.resolve() })
  if (!fact()) throw new Error(`[awaiting-fact] ${step}: still not so after 50 turns of React and the pending answers`)
}

describe('a group JSON file already open in Workspace', () => {
  let request = 9200
  const workspace = { ...slides('1.0.0'), id: 'workspace', contributes: { tabs: [{ name: 'main', title: 'Workspace', opensFiles: { chat: ['.json'] } }] } } as ExtensionManifest
  const soup = (claim: string) => ({ ...slides('1.0.0'), id: 'turtle-soup', name: '海龟汤', contributes: { tabs: [{ name: 'main', title: '海龟汤', opensFiles: { chat: [claim] } }] } }) as ExtensionManifest

  it.each([
    ['x.turtle-soup.json', '.turtle-soup.json', true],
    ['x.turtle-soup.json', '*.turtle-soup.json', true],
    ['x.turtle-soup.json', '.json', false],
    ['ordinary.json', '*.turtle-soup.json', false],
  ])('%s: a market App claiming %s is offered only when more specific (%s)', async (typedName, claim, offered) => {
    install([workspace])
    const manifest = soup(claim)
    here.market = { success: true, data: [{ manifest, version: manifest.version }] }
    vi.mocked(appsHere!.groupFileOpener).mockImplementation(async () => ({
      success: true, data: { ...file, name: typedName, typedName, choice: openerChoice(typedName, installedExtensionsStore.manifests, 'chat', () => null) },
    }))
    vi.mocked(appsHere!.installFromMarket).mockImplementation(async () => {
      install([workspace, manifest])
      return { success: true, data: { installed: true, outcome: 'confirmed', id: manifest.id, name: manifest.name, version: manifest.version } }
    })
    await openFile(++request)
    await until('Workspace opened the JSON', () => groupSlotMemory.opened('group-1')?.kind === 'workspace.main')
    await until('the cached market answered for the opened file', () => vi.mocked(appsHere!.marketOffers).mock.calls.length > 0)
    expect(offer() !== null).toBe(offered)
    if (offered) {
      expect(offer()?.dataset.offerFrom).toBe('market')
      expect(offer()?.textContent).toContain('用『海龟汤』打开')
      await act(async () => harness.container.querySelector<HTMLButtonElement>('[data-testid="group-app-slot-offer-install"]')!.click())
      await until('the same file opened in 海龟汤', () => groupSlotMemory.opened('group-1')?.kind === 'turtle-soup.main')
      expect(groupSlotMemory.opened('group-1')?.itemId).toBe(file.itemId)
      expect(appsHere!.installFromMarket).toHaveBeenCalledWith({ ref: { extensionId: manifest.id, version: manifest.version }, chatId: file.chatId })
      expect(offer()).toBeNull()
    }
  })
})

describe('a group file nobody here opens: the panel offers the App that would (161 10-15)', () => {
  it('the market’s App: named, said to be from the market; 「安装」 installs that version the one way, then the file opens in it', async () => {
    here.market = { success: true, data: [{ manifest: slides('1.2.0'), version: '1.2.0' }] }
    vi.mocked(appsHere!.installFromMarket).mockImplementation(async () => {
      install([slides('1.2.0')])
      return { success: true, data: { installed: true, outcome: 'confirmed', id: 'slides', name: 'Slides', version: '1.2.0' } }
    })
    await openFile(9101)
    await until('the panel offers an App', () => offer() !== null)
    expect(offer()?.dataset.offerFrom).toBe('market')
    expect(offer()?.textContent).toContain('用『Slides』打开')
    expect(offer()?.textContent).toContain('它是咕咕市场里的 App，在这里装一次就好。')
    // Nothing of the file is open to fold: no 「查看原始内容」 here.
    expect(harness.container.querySelector('[data-testid="group-app-slot-offer-raw"]')).toBeNull()

    await act(async () => harness.container.querySelector<HTMLButtonElement>('[data-testid="group-app-slot-offer-install"]')!.click())
    await until('the file opened in Slides', () => groupSlotMemory.opened('group-1')?.kind === 'slides.main')
    expect(appsHere!.installFromMarket).toHaveBeenCalledWith({ ref: { extensionId: 'slides', version: '1.2.0' }, chatId: 'group-1' })
    expect(appsHere!.groupFileOpener).toHaveBeenCalledTimes(2)
    expect(groupSlotMemory.opened('group-1')).toMatchObject({ kind: 'slides.main', itemId: 'item-1' })
    expect(offer()).toBeNull()
  })

  it('one shared in this chat comes first — the group’s own, installed from its card’s package', async () => {
    here.market = { success: true, data: [{ manifest: slides('1.2.0'), version: '1.2.0' }] }
    sharedHere.packages = new Map([['slides', { manifest: slides('1.1.0'), card: { source: { kind: 'url', url: 'https://files.test/slides.guguext' }, messageId: 'm-slides' } }]])
    vi.mocked(appsHere!.installAttachment).mockResolvedValue({ success: true, data: { installed: true, outcome: 'confirmed', id: 'slides', name: 'Slides', version: '1.1.0' } })
    await openFile(9102)
    await until('the panel offers an App', () => offer() !== null)
    expect(offer()?.dataset.offerFrom).toBe('shared')
    expect(offer()?.textContent).not.toContain('咕咕市场')
    await act(async () => harness.container.querySelector<HTMLButtonElement>('[data-testid="group-app-slot-offer-install"]')!.click())
    await until('the shared App was installed', () => vi.mocked(appsHere!.installAttachment).mock.calls.length === 1)
    expect(appsHere!.installAttachment).toHaveBeenCalledWith({ messageId: 'm-slides', chatId: 'group-1' })
    expect(appsHere!.installFromMarket).not.toHaveBeenCalled()
  })

  it('an install that fails says so under the offer (why goes to the log, not on screen)', async () => {
    here.market = { success: true, data: [{ manifest: slides('1.2.0'), version: '1.2.0' }] }
    vi.mocked(appsHere!.installFromMarket).mockResolvedValue({ success: false, error: 'the file does not match what was published' })
    await openFile(9103)
    await until('the panel offers an App', () => offer() !== null)
    await act(async () => harness.container.querySelector<HTMLButtonElement>('[data-testid="group-app-slot-offer-install"]')!.click())
    await until('the failed install is said', () => harness.container.querySelector('[data-testid="group-app-slot-offer-failed"]') !== null)
    expect(harness.container.querySelector('[data-testid="group-app-slot-offer-failed"]')?.textContent).toBe('没装上，稍后再试。')
  })

  it('control: nothing in the market opens it — said so, nothing offered', async () => {
    here.market = { success: true, data: [{ manifest: { ...slides('1.0.0'), id: 'notes', contributes: { tabs: [{ name: 'main', title: 'Notes', opensFiles: { chat: ['.md'] } }] } }, version: '1.0.0' }] }
    await openFile(9104)
    // The market has answered once this line is drawn: only then is 「nothing offered」 a reading.
    await until('the panel says nobody opens it', () => noOpener() !== null)
    expect(offer()).toBeNull()
    expect(noOpener()?.textContent).toBe('本机没有能打开『deck.pptx』的 App，咕咕市场里也没有。')
  })

  it('the market could not be read: said so — not 「the market has none」', async () => {
    here.market = { success: false, error: 'HTTP 503' }
    await openFile(9105)
    await until('the panel says nobody opens it', () => noOpener() !== null)
    expect(offer()).toBeNull()
    expect(noOpener()?.textContent).toBe('本机没有能打开『deck.pptx』的 App；咕咕市场现在读不到，稍后再试。')
  })
})

describe('a group file whose App is installed here but switched off (161 10-16: every App has its switch)', () => {
  const list = (disabled: string[]) =>
    act(() => installedExtensionsStore.applyList({ extensions: [slides('1.2.0')], invalid: [], disabled } as unknown as InstalledExtensionsList))

  it('said to be off, never offered to install again; 「启用」 switches it on the one way, then the file opens in it', async () => {
    here.market = { success: true, data: [{ manifest: slides('1.2.0'), version: '1.2.0' }] }
    groupSlotMemory.setOpened('group-1', null)
    list(['slides'])
    // Off, it claims no file: nobody here opens it — until it is on again.
    vi.mocked(appsHere!.groupFileOpener).mockImplementation(async () => {
      const on = installedExtensionsStore.manifests.some((manifest) => manifest.id === 'slides') && installedExtensionsStore.isEnabled('slides')
      const candidate = { extensionId: 'slides', app: { name: 'Slides' }, tabKind: 'slides.main', tabTitle: 'Slides', suffix: '.pptx', onlyTab: true }
      return { success: true, data: { ...file, choice: on ? { kind: 'one', candidate } : { kind: 'none' } } } as never
    })
    vi.mocked(appsHere!.setEnabled).mockImplementation(async () => {
      list([])
      return { success: true }
    })
    await openFile(9106)
    await until('the panel says Slides is switched off', () => switchedOff() !== null)
    expect(switchedOff()?.textContent).toContain('用『Slides』打开')
    expect(switchedOff()?.textContent).toContain('这个文件是『Slides』的，它装着，但停用了。启用它，就用它打开。')
    expect(offer()).toBeNull()
    expect(noOpener()).toBeNull()
    expect(groupSlotMemory.opened('group-1')).toBeNull()

    await act(async () => harness.container.querySelector<HTMLButtonElement>('[data-testid="group-app-slot-switch-on"]')!.click())
    await until('the file opened in Slides', () => groupSlotMemory.opened('group-1')?.kind === 'slides.main')
    expect(appsHere!.setEnabled).toHaveBeenCalledWith({ manifest: expect.objectContaining({ id: 'slides' }), enabled: true })
    expect(appsHere!.installFromMarket).not.toHaveBeenCalled()
    expect(switchedOff()).toBeNull()
  })

  it('control: switched on, it opens the file at once — no word about a switch', async () => {
    groupSlotMemory.setOpened('group-1', null)
    list([])
    await openFile(9107)
    await until('the file opened in Slides', () => groupSlotMemory.opened('group-1')?.kind === 'slides.main')
    expect(switchedOff()).toBeNull()
  })
})
