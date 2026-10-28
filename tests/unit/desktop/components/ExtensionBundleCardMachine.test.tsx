// @vitest-environment jsdom
// L4 10-02 (主人「第三项也带上吧」): an App card says which machine it installs on — this computer by default, or another
// machine this window is linked to, from the same list as a new task and the Library (deviceScopeTrayDevices over
// remoteHostsStore). That machine fetches and checks the card's package itself (installAttachment there). D-31 (owner 10-06
// 「怎么符合用户思维和操作路径怎么来」): the person is asked here, where they clicked — that machine hands back what it would
// ask, and installs only the bytes they agreed to, given where they ticked. Control (dev 9c3b90bab5): the card has no choice.
import { act, createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const manifest = {
  id: 'reader',
  name: 'Reader',
  version: '1.0.0',
  apiVersion: 3,
  entry: 'main.html',
  permissions: {},
  contributes: { tabs: [{ name: 'main', title: 'Read' }] },
}
const localInstall = vi.fn(async () => ({ success: true, data: { installed: true, outcome: 'confirmed', version: '1.0.0' } }))
const remoteInstalls: { machine: string | null; args: Record<string, unknown> }[] = []
/** What the other machine answers to an install (`consent: return` first): installed, or what it would ask. */
let thereAnswers = (_args: Record<string, unknown>, _machine?: string | null): Record<string, unknown> => ({ installed: true, outcome: 'confirmed' })
/** The machines this window is linked to (remoteHostsStore), as the store keeps them. */
const hosts = new Map<string, { device: Record<string, unknown> }>()
const host = (id: string, label: string, patch: Record<string, unknown> = {}) =>
  hosts.set(id, { device: { id, label, isOnline: true, platform: 'darwin', lastSeenAt: null, sessionDigest: null, directTerminal: false, hostKind: 'desktop', ...patch } })
const sheets: unknown[][] = []
let sheetAnswer: { outcome: string; alsoOn?: string[] } = { outcome: 'confirmed' }

vi.mock('../../../../apps/desktop/src/components/appSlot/appsHere', () => ({
  appsHere: { runs: () => true, grantable: (value: unknown) => value, installAttachment: localInstall },
}))
vi.mock('../../../../apps/desktop/src/session/renderer/lib/ipc', () => ({
  rpcOn: (machine: string | null) => ({
    extensions: {
      installAttachment: async (args: Record<string, unknown>) => {
        remoteInstalls.push({ machine, args })
        const data = thereAnswers(args, machine)
        // `failWith`: that machine's install failed (not a refusal) — the network, say.
        return typeof data.failWith === 'string' ? { success: false, error: data.failWith } : { success: true, data }
      },
    },
  }),
}))
vi.mock('../../../../apps/desktop/src/session/renderer/features/extensions/install-consent', () => ({
  installConsentPrompt: () => ({ title: 'Install Reader?', description: 'No permissions', confirmLabel: 'Install' }),
  askInShell: (...args: unknown[]) => {
    sheets.push(args)
    return Promise.resolve(sheetAnswer)
  },
}))
vi.mock('../../../../apps/desktop/src/session/renderer/features/remote-hosts/remote-hosts-store', () => ({
  remoteHostsStore: {
    hosts,
    device: (id: string) => hosts.get(id)?.device ?? null,
    connectionState: () => 'open',
    start: () => undefined,
  },
}))
vi.mock('../../../../apps/desktop/src/components/extensionBundle/sharedPackages', () => ({
  summaryOf: async () => ({ ok: true, manifest }),
  packageKey: (card: { source: { kind: string; url?: string }; messageId: string }) => (card.source.kind === 'url' ? `url:${card.source.url}` : `msg:${card.messageId}`),
  installPackageOf: (card: { messageId: string }) => ({ messageId: card.messageId }),
  showPackage: () => () => undefined,
  newestShownPackage: () => undefined,
  subscribeShownPackages: () => () => undefined,
  shownPackagesVersion: () => 0,
}))
vi.mock('../../../../apps/desktop/src/session/renderer/features/extensions/installed-extensions-store', () => ({
  installedExtensionsStore: { manifests: [] },
}))
vi.mock('../../../../apps/desktop/src/session/renderer/features/extensions/extension-consent', () => ({
  // Says which computer it was asked about (`machine`), so the card's preview can be read for it.
  describePermissions: (_manifest: unknown, _t: unknown, machine?: string) => (machine ? `No permissions, on ${machine}` : 'No permissions'),
}))
vi.mock('../../../../apps/desktop/src/session/renderer/localization/locale-store', () => ({
  translateSessionMessage: (key: string, params?: Record<string, string>) => (params ? `${key}:${Object.values(params).join('|')}` : key),
}))

const { ExtensionBundleCard } = await import('../../../../apps/desktop/src/components/extensionBundle/ExtensionBundleCard')
const { createReactHarness } = await import('../../../support/testHarness')

const URL_ = 'https://db.example/storage/v1/object/public/chat-media/u1/reader-1.0.0.guguext'
const ASK = { sourceDir: '/there/x', manifest, manifestDigest: 'digest-r', revokedPermissions: [], given: { first: true } }
const harnesses: ReturnType<typeof createReactHarness>[] = []
afterEach(() => {
  harnesses.splice(0).forEach((harness) => harness.cleanup())
  localInstall.mockClear()
  remoteInstalls.length = 0
  sheets.length = 0
  hosts.clear()
  thereAnswers = () => ({ installed: true, outcome: 'confirmed' })
  sheetAnswer = { outcome: 'confirmed' }
})

const OLD_CARD = { source: { kind: 'url' as const, url: URL_ }, messageId: 'm-old' }
async function card(pkg: { source: unknown; messageId: string } = OLD_CARD) {
  const harness = createReactHarness()
  harnesses.push(harness)
  await harness.render(createElement(ExtensionBundleCard, { meta: { sizeBytes: 1024, fileName: 'reader-1.0.0.guguext' }, card: pkg as never, isMine: false, chatId: 'g1' }))
  // The summary arrives a tick later (summaryOf).
  await act(async () => undefined)
  const q = (selector: string) => harness.container.querySelector<HTMLElement>(selector)
  const pick = async (id: string) => {
    const picker = q('[data-testid="extension-bundle-card-machine"]') as HTMLSelectElement
    await act(async () => {
      picker.value = id
      picker.dispatchEvent(new Event('change', { bubbles: true }))
    })
  }
  return { q, pick, install: () => q('[data-testid="extension-bundle-card-install"]')! }
}

describe('an App card installs on the machine the person picks', () => {
  // 复核 10-15: the card's preview is what the consent will say where it installs — the machine picked, named.
  it('the permission preview follows the machine picked: this device, then the other one by name', async () => {
    host('dev-b', 'mac1 B')
    const { q, pick } = await card()
    expect(q('[data-testid="extension-bundle-card-permissions"]')?.textContent).toBe('No permissions')
    await pick('dev-b')
    expect(q('[data-testid="extension-bundle-card-permissions"]')?.textContent).toBe('No permissions, on mac1 B')
  })

  it('the shared list: this computer first, then the machines this window is linked to — offline ones and a Gugu server (no window, no Apps) not choosable', async () => {
    host('dev-b', 'mac1 B')
    host('off', 'old laptop', { isOnline: false })
    host('srv', 'gpu server', { hostKind: 'server' })
    const { q } = await card()
    const picker = q('[data-testid="extension-bundle-card-machine"]') as HTMLSelectElement
    expect([...picker.options].map((option) => [option.value, option.textContent, option.disabled])).toEqual([
      ['local', 'task.deviceLocal', false],
      ['dev-b', 'mac1 B', false],
      ['off', 'old laptop', true],
      ['srv', 'gpu server', true],
    ])
    expect(picker.value).toBe('local')
  })

  it("another machine asking nothing: it installs the card's package, and the card says it is there", async () => {
    host('dev-b', 'mac1 B')
    const { q, pick, install } = await card()
    await pick('dev-b')
    await act(async () => install().click())
    expect(remoteInstalls).toEqual([{ machine: 'dev-b', args: { messageId: 'm-old', chatId: 'g1', consent: { kind: 'return' } } }])
    expect(sheets).toEqual([])
    expect(localInstall).not.toHaveBeenCalled()
    expect(q('[data-testid="extension-bundle-card-there"]')?.textContent).toBe('extensions.bundleCardInstalledOn:mac1 B')
  })

  it('#7290 a card in the group folder, too: that machine is asked by the message (it reads it as the same person), never a URL', async () => {
    host('dev-b', 'mac1 B')
    const { pick, install } = await card({ source: { kind: 'item', itemId: 'i1', version: 1 }, messageId: 'm-new' })
    await pick('dev-b')
    await act(async () => install().click())
    expect(remoteInstalls).toEqual([{ machine: 'dev-b', args: { messageId: 'm-new', chatId: 'g1', consent: { kind: 'return' } } }])
  })

  it('another machine that asks: the person is asked here (naming it), and it installs only the bytes agreed to', async () => {
    host('dev-b', 'mac1 B')
    thereAnswers = (args) => ((args.consent as { kind: string }).kind === 'return'
      ? { installed: false, outcome: 'ask', id: 'reader', ask: ASK }
      : { installed: true, outcome: 'confirmed', id: 'reader' })
    const { q, pick, install } = await card()
    await pick('dev-b')
    await act(async () => install().click())
    expect(sheets).toHaveLength(1)
    // What it gives there is that machine's own answer, and the machine is named on the sheet.
    expect(sheets[0]?.[3]).toEqual(ASK.given)
    expect(sheets[0]?.[5]).toBe('mac1 B')
    expect(remoteInstalls.map(({ args }) => args.consent)).toEqual([{ kind: 'return' }, { kind: 'given', digest: 'digest-r' }])
    expect(q('[data-testid="extension-bundle-card-there"]')?.textContent).toBe('extensions.bundleCardInstalledOn:mac1 B')
  })

  it('the person says no here: nothing is installed there', async () => {
    host('dev-b', 'mac1 B')
    thereAnswers = () => ({ installed: false, outcome: 'ask', id: 'reader', ask: ASK })
    sheetAnswer = { outcome: 'declined' }
    const { q, pick, install } = await card()
    await pick('dev-b')
    await act(async () => install().click())
    expect(remoteInstalls).toHaveLength(1)
    expect(q('[data-testid="extension-bundle-card-there"]')).toBeNull()
  })

  // owner 10-16「装的时候一次选好装到哪几台」: with another machine linked, this computer's install is asked in this window
  // too, so the one sheet can list the others; ticked, the same yes installs there — only the package agreed to.
  it('this computer, with another one linked: asked here, listing it; ticked, the same yes installs it there too', async () => {
    host('dev-b', 'mac1 B')
    host('off', 'old laptop', { isOnline: false })
    thereAnswers = (args) => ((args.consent as { kind: string }).kind === 'return'
      ? { installed: false, outcome: 'ask', id: 'reader', ask: ASK }
      : { installed: true, outcome: 'confirmed', id: 'reader', version: '1.0.0' })
    sheetAnswer = { outcome: 'confirmed', alsoOn: ['dev-b'] }
    const { q, install } = await card()
    await act(async () => install().click())
    expect(localInstall).not.toHaveBeenCalled()
    // The sheet lists the other online machine by name; this one is not named (it is this computer).
    expect(sheets[0]?.[5]).toBeUndefined()
    expect(sheets[0]?.[6]).toEqual([{ id: 'dev-b', label: 'mac1 B' }])
    expect(remoteInstalls.map(({ machine, args }) => [machine, args.consent])).toEqual([
      [null, { kind: 'return' }],
      [null, { kind: 'given', digest: 'digest-r' }],
      ['dev-b', { kind: 'return' }],
      ['dev-b', { kind: 'given', digest: 'digest-r' }],
    ])
    // Architecture I3: the computer ticked as well installs there — not for this chat — so it adds no row of this chat's
    // that the sheet never named; the computer the sheet was for installs for the chat, as the card asked.
    expect(remoteInstalls.filter(({ machine }) => machine === 'dev-b').every(({ args }) => !('chatId' in args))).toBe(true)
    expect(remoteInstalls.filter(({ machine }) => machine === null).every(({ args }) => args.chatId === 'g1')).toBe(true)
    expect(q('[data-testid="extension-bundle-card-there"]')?.textContent).toBe('extensions.bundleCardInstalledOn:mac1 B')
  })

  it('a machine ticked that fetched another package installs nothing there, and says so', async () => {
    host('dev-b', 'mac1 B')
    thereAnswers = (args, machine) => ((args.consent as { kind: string }).kind === 'return'
      ? { installed: false, outcome: 'ask', id: 'reader', ask: machine === 'dev-b' ? { ...ASK, manifestDigest: 'digest-other' } : ASK }
      : { installed: true, outcome: 'confirmed', id: 'reader' })
    sheetAnswer = { outcome: 'confirmed', alsoOn: ['dev-b'] }
    const { q, install } = await card()
    await act(async () => install().click())
    expect(remoteInstalls.filter(({ machine }) => machine === 'dev-b').map(({ args }) => args.consent)).toEqual([{ kind: 'return' }])
    expect(q('[data-testid="extension-bundle-card-there"]')?.textContent).toBe('extensions.bundleCardNotInstalledOn:mac1 B')
  })

  it('no other machine linked (a phone, or only this computer): no choice is drawn', async () => {
    const { q } = await card()
    expect(q('[data-testid="extension-bundle-card-machine"]')).toBeNull()
  })
})

// 复核 #7300 要改 4: two other computers ticked in the one sheet — the first fetched another package (not installed there),
// the second installed it. Each says what it came to, by name: one that did not install is never hidden behind the other.
describe('two other computers ticked on a card', () => {
  it('each says what it came to — the one that did not install, too', async () => {
    host('dev-b', 'mac1 B')
    host('dev-c', 'mac1 C')
    thereAnswers = (args, machine) => ((args.consent as { kind: string }).kind === 'return'
      ? { installed: false, outcome: 'ask', id: 'reader', ask: machine === 'dev-b' ? { ...ASK, manifestDigest: 'digest-other' } : ASK }
      : { installed: true, outcome: 'confirmed', id: 'reader', version: '1.0.0' })
    sheetAnswer = { outcome: 'confirmed', alsoOn: ['dev-b', 'dev-c'] }
    const { install } = await card()
    await act(async () => install().click())
    const calls = remoteInstalls.map(({ machine, args }) => `${machine}:${(args.consent as { kind: string }).kind}`)
    expect(calls).toEqual(['null:return', 'null:given', 'dev-b:return', 'dev-c:return', 'dev-c:given'])
    const there = [...document.querySelectorAll('[data-testid="extension-bundle-card-there"]')].map((element) => element.textContent)
    expect(there).toEqual(['extensions.bundleCardNotInstalledOn:mac1 B', 'extensions.bundleCardInstalledOn:mac1 C'])
  })
})

// 复核 cf03d66d35: E-05 can refuse at the second step too — that computer got the market's copy of the App while the person
// read the sheet. The card reads both answers with `answered` (as installAgreedOn does): a refusal at either step is said,
// with what is there, never counted as installed; the other computers ticked under the same yes each say what they came to.
describe('a refusal after the yes (E-05 at the second step)', () => {
  const REFUSED = { installed: false, outcome: 'refused', id: 'reader', name: 'Reader', version: '1.0.0', reason: 'a package from chat cannot replace it', from: 'market', installedVersion: '0.9.0' }
  const askThenRefuse = (refuseOn: (machine: string | null | undefined) => boolean) => (args: Record<string, unknown>, machine?: string | null) =>
    (args.consent as { kind: string }).kind === 'return'
      ? { installed: false, outcome: 'ask', id: 'reader', ask: ASK }
      : refuseOn(machine) ? REFUSED : { installed: true, outcome: 'confirmed', id: 'reader', version: '1.0.0' }

  it('the machine picked refuses with the yes: the card says what is there, not that it installed', async () => {
    host('dev-b', 'mac1 B')
    thereAnswers = askThenRefuse((machine) => machine === 'dev-b')
    const { q, pick, install } = await card()
    await pick('dev-b')
    await act(async () => install().click())
    expect(remoteInstalls.map(({ args }) => (args.consent as { kind: string }).kind)).toEqual(['return', 'given'])
    const said = q('[data-testid="extension-bundle-card-there"]')
    expect(said?.dataset.installed).toBe('false')
    expect(said?.textContent).toContain('extensions.installedHereMarket')
    expect(said?.textContent).toContain('mac1 B')
    expect(said?.textContent).toContain('extensions.chatCannotReplace')
  })

  it('this computer refuses with the yes: said here; the computer ticked with it still installs, and says so', async () => {
    host('dev-b', 'mac1 B')
    thereAnswers = askThenRefuse((machine) => machine === null)
    sheetAnswer = { outcome: 'confirmed', alsoOn: ['dev-b'] }
    const { q, install } = await card()
    await act(async () => install().click())
    expect(q('[data-testid="extension-bundle-card-refused"]')?.textContent).toContain('extensions.chatCannotReplace')
    expect(remoteInstalls.map(({ machine, args }) => `${machine}:${(args.consent as { kind: string }).kind}`)).toEqual(['null:return', 'null:given', 'dev-b:return', 'dev-b:given'])
    expect(q('[data-testid="extension-bundle-card-there"]')?.textContent).toBe('extensions.bundleCardInstalledOn:mac1 B')
  })

  // 复核 acd3015dad (X4): the machine picked refuses at once — before any sheet — with what is there; nothing is asked.
  it('the machine picked refuses at the first step: said with what is there, one call, no sheet', async () => {
    host('dev-b', 'mac1 B')
    thereAnswers = () => REFUSED
    const { q, pick, install } = await card()
    await pick('dev-b')
    await act(async () => install().click())
    expect(remoteInstalls).toHaveLength(1)
    expect(sheets).toEqual([])
    const said = q('[data-testid="extension-bundle-card-there"]')
    expect(said?.dataset.installed).toBe('false')
    expect(said?.textContent).toContain('extensions.chatCannotReplace')
  })

  it('this device alone (no other machine): its one-step install refused is said with what is there', async () => {
    localInstall.mockResolvedValueOnce({ success: true, data: REFUSED } as never)
    const { q, install } = await card()
    await act(async () => install().click())
    expect(localInstall).toHaveBeenCalledTimes(1)
    expect(q('[data-testid="extension-bundle-card-refused"]')?.textContent).toContain('extensions.chatCannotReplace')
  })

  it('this computer fails with the yes for another reason (the network): the computer ticked still installs and says so', async () => {
    host('dev-b', 'mac1 B')
    // This computer's own second answer is a failure, not a refusal; the computer ticked installs.
    const installs = askThenRefuse(() => false)
    thereAnswers = (args, machine) => (machine === null && (args.consent as { kind: string }).kind === 'given' ? { failWith: 'network down' } : installs(args, machine))
    sheetAnswer = { outcome: 'confirmed', alsoOn: ['dev-b'] }
    const { q, install } = await card()
    await act(async () => install().click())
    expect(remoteInstalls.map(({ machine, args }) => `${machine}:${(args.consent as { kind: string }).kind}`)).toEqual(['null:return', 'null:given', 'dev-b:return', 'dev-b:given'])
    expect(q('[data-testid="extension-bundle-card-there"]')?.textContent).toBe('extensions.bundleCardInstalledOn:mac1 B')
    expect(harnesses.at(-1)!.container.textContent).toContain('extensions.bundleCardInstallFailed')
  })

  it('a computer ticked refuses with the yes: it says so, with what is there', async () => {
    host('dev-b', 'mac1 B')
    thereAnswers = askThenRefuse((machine) => machine === 'dev-b')
    sheetAnswer = { outcome: 'confirmed', alsoOn: ['dev-b'] }
    const { q, install } = await card()
    await act(async () => install().click())
    const said = q('[data-testid="extension-bundle-card-there"]')
    expect(said?.dataset.installed).toBe('false')
    expect(said?.textContent).toContain('extensions.chatCannotReplace')
  })
})
