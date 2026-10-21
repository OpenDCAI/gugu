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

/** A more specific App is still offered for a JSON file already claimed by Workspace. */

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
const file = { chatId: 'group-1', itemId: 'item-1', name: 'deck.pptx', typedName: 'deck.pptx', file: { document: false, contentType: 'application/json', version: 1, size: 10 } }
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
