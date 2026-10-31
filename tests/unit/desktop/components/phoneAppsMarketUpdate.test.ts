// @vitest-environment jsdom
// 161 10-15: a market App on the phone says where it came from, and when the market has a newer version for this phone the
// row offers 「更新到 vX」 — installed the one way (phoneApps.installFromMarket), asked only when it asks for more. Without
// it an App's fixes never reach the phone. The phone's App store is played here; its install is measured in phoneApps76.
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'

const NOTHING_NEWER = { success: true, data: { checkedAt: '', updates: {}, yanked: {}, deprecated: {} } }
const phone = vi.hoisted(() => ({
  ready: vi.fn(async () => undefined),
  marketUpdates: vi.fn(async (): Promise<unknown> => ({ success: true, data: { checkedAt: '', updates: {}, yanked: {}, deprecated: {} } })),
  installFromMarket: vi.fn(async (): Promise<unknown> => ({ success: true, data: { installed: true, outcome: 'confirmed', id: 'notes', name: 'Notes', version: '1.1.0' } })),
  uninstall: vi.fn(async () => ({ success: true, data: null })),
  // The shell's switch: phoneApps keeps the list and tells the store (tell → applyList); played here on the store below.
  setEnabled: vi.fn(async (_id: string, _enabled: boolean): Promise<unknown> => ({ success: true, data: null })),
  setAutoUpdate: vi.fn(async (_id: string, _on: boolean): Promise<unknown> => ({ success: true, data: null })),
  originOf: (id: string) => (id === 'notes' ? 'market' : 'attachment'),
  // The index in hand (market-snapshot.ts): the page asks the download site once it opens; `heard` is who listens.
  market: {
    heard: [] as ((refreshed: { outcome: string; fetchedAt: string | null }) => void)[],
    refresh: vi.fn(async () => ({ outcome: 'unchanged', fetchedAt: '2026-10-16T01:00:00.000Z' })),
    history: vi.fn(async (): Promise<unknown> => []),
    onRefreshed(listener: (refreshed: { outcome: string; fetchedAt: string | null }) => void) {
      phone.market.heard.push(listener)
      return () => {
        phone.market.heard = phone.market.heard.filter((other) => other !== listener)
      }
    },
  },
}))
vi.mock('../../../../apps/desktop/src/components/appSlot/phoneApps', () => ({ phoneApps: phone }))
vi.mock('../../../../apps/desktop/src/session/renderer/features/extensions/installed-extensions-store', async () => {
  const { observable } = await import('mobx')
  const app = (id: string, name: string) => ({ id, name, version: '1.0.0', apiVersion: 4, defaultLocale: 'en', entry: 'index.html', contributes: { tabs: [{ name: 'main', title: name }] } })
  return {
    installedExtensionsStore: observable({
      manifests: [app('notes', 'Notes'), app('vote', 'Vote')],
      origins: {} as Record<string, string>,
      isPreinstalled(id: string) {
        return this.origins[id] === 'preinstalled'
      },
      disabled: [] as string[],
      isEnabled(id: string) {
        return !this.disabled.includes(id)
      },
      // Notes is the market's: it has a 「自动更新」 switch; Vote came from a chat and has none.
      autoUpdateOff: [] as string[],
      autoUpdates(id: string) {
        return id === 'notes' ? !this.autoUpdateOff.includes(id) : null
      },
      invalid: [] as unknown[],
      publishers: { notes: { id: 'gugu' }, vote: { id: 'alice', name: 'Alice' } },
      // Notes has a page of its own; Vote only opens its files.
      mainTabOf(id: string) {
        return id === 'notes' ? { kind: 'notes.main' } : null
      },
    }),
  }
})
const { followLink } = vi.hoisted(() => ({ followLink: vi.fn(() => true) }))
vi.mock('../../../../apps/desktop/src/lib/guguLinks', () => ({ followLink }))
const { AppsSection } = await import('../../../../apps/desktop/src/components/settings/AppsSection')
const { installedExtensionsStore: store } = (await import('../../../../apps/desktop/src/session/renderer/features/extensions/installed-extensions-store')) as unknown as {
  installedExtensionsStore: { disabled: string[]; autoUpdateOff: string[] }
}

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  harness = createReactHarness()
  followLink.mockClear()
  // Nothing newer unless a case says so (an answer set in one case is not left for the next).
  phone.marketUpdates.mockReset().mockResolvedValue(NOTHING_NEWER)
  phone.installFromMarket.mockClear()
  phone.market.refresh.mockClear()
  phone.market.heard = []
  phone.setEnabled.mockReset().mockImplementation(async (id: string, enabled: boolean) => {
    store.disabled = enabled ? store.disabled.filter((one) => one !== id) : [...store.disabled, id]
    return { success: true, data: null }
  })
  store.disabled = []
  store.autoUpdateOff = []
  phone.installFromMarket.mockClear()
  phone.setAutoUpdate.mockReset().mockImplementation(async (id: string, on: boolean) => {
    store.autoUpdateOff = on ? store.autoUpdateOff.filter((one) => one !== id) : [...store.autoUpdateOff, id]
    return { success: true, data: null }
  })
  phone.market.history.mockReset().mockResolvedValue([])
})
afterEach(() => harness.cleanup())

const row = (id: string) => harness.container.querySelector(`[data-app-id="${id}"]`)
const updateButton = (id: string) => row(id)?.querySelector<HTMLButtonElement>('[data-testid="settings-apps-update"]') ?? null
/** React and the pending answers flushed until `fact` holds — a bounded number of turns, never a clock; red names the step. */
async function until(step: string, fact: () => boolean) {
  for (let turn = 0; turn < 50 && !fact(); turn++) await act(async () => { await Promise.resolve() })
  if (!fact()) throw new Error(`[awaiting-fact] ${step}: still not so after 50 turns of React and the pending answers`)
}
/** The market's answer for this render has come and been drawn: what the rows say about updates is final. */
async function marketAnswered(calls: number) {
  await until(`the market was asked ${calls} time(s)`, () => phone.marketUpdates.mock.calls.length >= calls)
  await act(async () => { await phone.marketUpdates.mock.results[calls - 1]!.value })
}

describe('「App」 on the phone: market Apps say so, and are updated from here', () => {
  it('a market App with a newer version for this phone offers 「更新到 1.1.0」; the press installs that version the one way', async () => {
    phone.marketUpdates.mockResolvedValue({ success: true, data: { checkedAt: '', updates: { notes: { version: '1.1.0', releaseNotes: '' } }, yanked: {}, deprecated: {} } })
    await harness.render(createElement(AppsSection))
    await until('notes offers its update', () => updateButton('notes') !== null)
    expect(row('notes')?.textContent).toContain('1.0.0 · 来自咕咕市场')
    expect(row('vote')?.textContent).toContain('1.0.0 · 来自 Alice')
    expect(updateButton('notes')?.textContent).toBe('更新到 1.1.0')
    expect(updateButton('vote')).toBeNull()

    await act(async () => { updateButton('notes')!.click() })
    await until('the update installed from the market', () => phone.installFromMarket.mock.calls.length === 1)
    expect(phone.installFromMarket).toHaveBeenCalledWith({ ref: { extensionId: 'notes', version: '1.1.0' } })
    // Asked again once it is in: what the market offers now.
    await until('the market was asked again', () => phone.marketUpdates.mock.calls.length === 2)
  })

  // owner 10-16「本地有缓存啊」: the buttons come from the index in hand at once; the download site is asked behind them, and
  // an index that came back different is read again — the 「更新到 vX」 it brings appears where the row is.
  it('opened: asks the download site once behind the rows; the index came back changed → 「更新到 1.1.0」 appears', async () => {
    await harness.render(createElement(AppsSection))
    await marketAnswered(1)
    expect(phone.market.refresh).toHaveBeenCalledTimes(1)
    expect(updateButton('notes')).toBeNull()
    phone.marketUpdates.mockResolvedValue({ success: true, data: { checkedAt: '', updates: { notes: { version: '1.1.0', releaseNotes: '' } }, yanked: {}, deprecated: {} } })
    await act(async () => { for (const listener of phone.market.heard) listener({ outcome: 'unchanged', fetchedAt: '2026-10-16T01:00:00.000Z' }) })
    expect(phone.marketUpdates).toHaveBeenCalledTimes(1)
    await act(async () => { for (const listener of phone.market.heard) listener({ outcome: 'changed', fetchedAt: '2026-10-16T01:01:00.000Z' }) })
    await until('notes offers the update the new index brought', () => updateButton('notes') !== null)
    expect(updateButton('notes')?.textContent).toBe('更新到 1.1.0')
    // Gone with the page: nothing left listening.
    await harness.render(null)
    expect(phone.market.heard).toHaveLength(0)
  })

  it('control: nothing newer in the market — no 「更新」, once the market has answered', async () => {
    await harness.render(createElement(AppsSection))
    await marketAnswered(1)
    expect(row('notes')?.textContent).toContain('1.0.0 · 来自咕咕市场')
    expect(harness.container.querySelector('[data-testid="settings-apps-update"]')).toBeNull()
  })
})

describe('「App」 on the phone: every App has its switch, as on the desktop (161 10-16)', () => {
  const switchOf = (id: string) => row(id)?.querySelector<HTMLElement>('[data-testid="settings-apps-switch"]') ?? null
  const press = async (id: string) => {
    const toggle = switchOf(id)?.querySelector<HTMLElement>('[role="switch"]') ?? null
    expect(toggle, id).not.toBeNull()
    await act(async () => { toggle!.click() })
  }

  it('each row has one, on; turned off, phoneApps is asked, the row says it is not enabled; turned on again, the same way back', async () => {
    await harness.render(createElement(AppsSection))
    await marketAnswered(1)
    expect(switchOf('notes')?.dataset.enabled).toBe('true')
    expect(switchOf('vote')?.dataset.enabled).toBe('true')
    expect(row('vote')?.textContent).not.toContain('未启用')

    await press('vote')
    await until('vote was switched off', () => switchOf('vote')?.dataset.enabled === 'false')
    expect(phone.setEnabled).toHaveBeenLastCalledWith('vote', false)
    expect(row('vote')?.textContent).toContain('1.0.0 · 来自 Alice · 未启用')
    // Off is not gone: the row and its uninstall stay.
    expect(row('vote')?.querySelector('[data-testid="settings-apps-uninstall"]')).not.toBeNull()
    expect(switchOf('notes')?.dataset.enabled).toBe('true')

    await press('vote')
    await until('vote was switched on', () => switchOf('vote')?.dataset.enabled === 'true')
    expect(phone.setEnabled).toHaveBeenLastCalledWith('vote', true)
    expect(row('vote')?.textContent).not.toContain('未启用')
  })

  it('a switch the phone refuses says so, in the words the desktop uses', async () => {
    phone.setEnabled.mockResolvedValueOnce({ success: false, error: '"vote" is not installed' })
    await harness.render(createElement(AppsSection))
    await marketAnswered(1)
    await press('vote')
    await until('the refusal is said', () => harness.container.querySelector('[data-testid="settings-apps-failed"]') !== null)
    expect(harness.container.querySelector('[data-testid="settings-apps-failed"]')?.textContent).toContain('"vote" is not installed')
    expect(switchOf('vote')?.dataset.enabled).toBe('true')
  })
})

describe('「App」 on the phone: an App with a page of its own opens it from its row', () => {
  const openButton = (id: string) => row(id)?.querySelector<HTMLButtonElement>('[data-testid="settings-apps-open"]') ?? null

  it('「打开」 asks the common opener for its own page; file-only Apps have no such button', async () => {
    await harness.render(createElement(AppsSection))
    await marketAnswered(1)
    expect(openButton('notes')?.textContent).toBe('打开')
    expect(openButton('vote')).toBeNull()
    await act(async () => { openButton('notes')!.click() })
    expect(followLink).toHaveBeenCalledExactlyOnceWith({ kind: 'app', extensionId: 'notes', tab: 'main', path: '', query: {}, place: null })
  })

  it('switched off: no 「打开」 (it is not opened)', async () => {
    store.disabled = ['notes']
    await harness.render(createElement(AppsSection))
    await marketAnswered(1)
    expect(row('notes')).not.toBeNull()
    expect(openButton('notes')).toBeNull()
  })
})

// owner 10-19: an App updated by itself while the page is open — what the market has to say is read again, no stale 「更新到」.
describe('「App」 on the phone: an App updated by itself', () => {
  it('the installed version changing reads the market again: the row no longer offers the version it now has', async () => {
    phone.marketUpdates.mockResolvedValue({ success: true, data: { checkedAt: '', updates: { notes: { version: '1.1.0', releaseNotes: '' } }, yanked: {}, deprecated: {} } })
    await harness.render(createElement(AppsSection))
    await until('notes offers its update', () => updateButton('notes') !== null)
    phone.marketUpdates.mockResolvedValue(NOTHING_NEWER)
    const manifests = (store as unknown as { manifests: { id: string; version: string }[] }).manifests
    await act(async () => { manifests[0]!.version = '1.1.0' })
    await until('the update is gone', () => updateButton('notes') === null)
    manifests[0]!.version = '1.0.0'
  })
})

// owner 10-19: a market App's 「版本」 — its 「自动更新」 switch and every version, any of which installs (the desktop's history).
describe('「App」 on the phone: a market App’s versions and its 「自动更新」', () => {
  const doc = () => harness.container.ownerDocument
  const versionRow = (version: string) => doc().querySelector(`[data-testid="settings-apps-version-${version}"]`)
  const history = [
    { version: '1.2.0', publishedAt: '2026-10-18T00:00:00Z', releaseNotes: 'Needs more', apiVersion: 4, minAppVersion: '9.0.0', yanked: null, compat: { reason: 'needs-newer-app', minAppVersion: '9.0.0' } },
    { version: '1.1.0', publishedAt: '2026-10-17T00:00:00Z', releaseNotes: '- Faster', apiVersion: 4, minAppVersion: '0.1.0', yanked: null, compat: null },
    { version: '1.0.0', publishedAt: '2026-10-16T00:00:00Z', releaseNotes: 'First', apiVersion: 4, minAppVersion: '0.1.0', yanked: null, compat: null },
    { version: '0.9.0', publishedAt: '2026-10-15T00:00:00Z', releaseNotes: 'Old', apiVersion: 4, minAppVersion: '0.1.0', yanked: { reason: 'broke' }, compat: null },
  ]

  it('only a market App has 「版本」; its sheet lists every version, the installed one marked, the rest installable or saying why not', async () => {
    phone.market.history.mockResolvedValue(history)
    await harness.render(createElement(AppsSection))
    await marketAnswered(1)
    expect(row('vote')?.querySelector('[data-testid="settings-apps-versions"]')).toBeNull()
    await act(async () => { row('notes')!.querySelector<HTMLButtonElement>('[data-testid="settings-apps-versions"]')!.click() })
    await until('the versions are drawn', () => versionRow('1.1.0') !== null)
    expect(phone.market.history).toHaveBeenCalledWith('notes')
    expect(versionRow('1.2.0')?.textContent).toContain('需要更新咕咕')
    expect(versionRow('1.2.0')?.querySelector('button')).toBeNull()
    expect(versionRow('1.1.0')?.querySelector('button')?.textContent).toBe('更新')
    expect(versionRow('1.0.0')?.textContent).toContain('当前版本')
    expect(versionRow('0.9.0')?.textContent).toContain('已撤回')
    expect(versionRow('0.9.0')?.querySelector('button')).toBeNull()

    await act(async () => { versionRow('1.1.0')!.querySelector('button')!.click() })
    await until('that version was installed', () => phone.installFromMarket.mock.calls.length === 1)
    expect(phone.installFromMarket).toHaveBeenCalledWith({ ref: { extensionId: 'notes', version: '1.1.0' } })
  })

  it('「自动更新」 on says what an older version does; turned off, phoneApps is asked and the sheet says it is pinned', async () => {
    await harness.render(createElement(AppsSection))
    await marketAnswered(1)
    await act(async () => { row('notes')!.querySelector<HTMLButtonElement>('[data-testid="settings-apps-versions"]')!.click() })
    const toggle = () => doc().querySelector<HTMLElement>('[data-testid="settings-apps-auto-update"]')
    await until('the switch is drawn', () => toggle() !== null)
    expect(toggle()?.dataset.on).toBe('true')
    expect(doc().querySelector('[data-testid="settings-apps-versions-sheet"]')?.textContent).toContain('安装旧版本后，此 App 的自动更新将关闭')
    await act(async () => { toggle()!.querySelector<HTMLElement>('[role="switch"]')!.click() })
    await until('switched off', () => toggle()?.dataset.on === 'false')
    expect(phone.setAutoUpdate).toHaveBeenLastCalledWith('notes', false)
    expect(doc().querySelector('[data-testid="settings-apps-versions-sheet"]')?.textContent).toContain('已固定在 v1.0.0，自动更新已关闭')
  })
})
