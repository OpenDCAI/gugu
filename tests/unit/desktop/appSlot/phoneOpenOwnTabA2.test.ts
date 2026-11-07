// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hostAppFrame } from '../../../../apps/desktop/src/components/appSlot/phoneAppHost'
import { phoneApps } from '../../../../apps/desktop/src/components/appSlot/phoneApps'
import { APP_FRAME_MARKER } from '../../../../apps/desktop/src/session/shared/extensions/app-runtime-protocol'
import { EXTENSION_API_VERSION, parseExtensionManifest } from '../../../../apps/desktop/src/session/shared/extensions/manifest'

/**
 * A2 (data-lens 评审), the phone's half: `files.openWith(file, { tab })` from a page on the phone opens the chat file in
 * its own App's tab that claims it — the same answer as the desktop's main (`ownTabChoice`, file-openers.ts): no
 * 「打开方式」, the person's 「始终用它」 (`phoneApps.remembered`) neither read nor written. Without `tab`, as before.
 * Harness as phoneGestureB4.test.ts: the real host, the App's calls as its gate posts them; only `openTarget` stubbed.
 */

const ORIGIN = 'https://data-lens.acct.apps.gugu.invalid'
const { CHAT, SALES } = vi.hoisted(() => ({ CHAT: '0b000000-0000-4000-8000-0000000000c2', SALES: '0c000000-0000-4000-8000-0000000000c2' }))
const apps = vi.hoisted(() => ({ manifests: [] as unknown[] }))
vi.mock('../../../../apps/desktop/src/session/renderer/features/extensions/installed-extensions-store', () => ({
  installedExtensionsStore: {
    get manifests() { return apps.manifests },
    icons: {},
    locale: 'en',
    isEnabled: () => true,
    manifestFor: (id: string) => (apps.manifests as { id: string }[]).find((manifest) => manifest.id === id),
  },
}))
vi.mock('../../../../apps/desktop/src/store/devicesCache', () => ({ readCachedDevices: () => [] }))
vi.mock('../../../../apps/desktop/src/mobile/agent-watch/sessionpage-rpc', () => ({ fetchSessionsList: vi.fn() }))
// Where the file is and whether this page may read it are `openTarget`'s, unchanged by A2 (its own tests): here it
// answers the chat's sales.xlsx; who opens it is the host's real answer over the Apps on this phone.
vi.mock('../../../../apps/desktop/src/session/shared/extensions/app-files-core', async (importOriginal) => {
  const core = await importOriginal<typeof import('../../../../apps/desktop/src/session/shared/extensions/app-files-core')>()
  return {
    ...core,
    createAppFiles: (...args: Parameters<typeof core.createAppFiles>) => {
      const files = core.createAppFiles(...args)
      return new Proxy(files, {
        get: (target, key, receiver) => key === 'openTarget'
          ? async () => ({ chatId: CHAT, itemId: SALES, name: 'sales.xlsx', typedName: 'sales.xlsx', file: { document: false, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', version: 2, size: 4096 } })
          : Reflect.get(target, key, receiver),
      })
    },
  }
})

const dataLens = parseExtensionManifest({
  id: 'data-lens', name: 'Data Lens', version: '1.0.0', apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en', entry: 'index.html',
  contributes: { tabs: [
    { name: 'card', title: 'Data Lens', entry: 'card.html' },
    { name: 'explore', title: 'Data Lens', entry: 'explore.html', opensFiles: { chat: ['.csv', '.xlsx', '.sqlite'] } },
  ] },
})
const office = parseExtensionManifest({
  id: 'office', name: '咕咕办公', version: '1.0.0', apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en', entry: 'index.html',
  contributes: { tabs: [{ name: 'sheet', title: 'Office', entry: 'sheet.html', opensFiles: { chat: ['.xlsx'] } }] },
})

let remembered: Record<string, string> = {}
let frame: HTMLIFrameElement
let posted: ReturnType<typeof vi.fn>
let opened: ReturnType<typeof vi.fn>
let peeked: ReturnType<typeof vi.fn>
let host: ReturnType<typeof hostAppFrame> | undefined
Object.defineProperty(navigator, 'userActivation', { value: { isActive: false }, configurable: true })

beforeEach(() => {
  apps.manifests = [dataLens, office]
  remembered = {}
  vi.spyOn(phoneApps, 'remembered').mockImplementation((key: string) => remembered[key] ?? null)
  frame = document.createElement('iframe')
  frame.src = `${ORIGIN}/card.html`
  document.body.appendChild(frame)
  posted = vi.fn()
  Object.defineProperty(frame.contentWindow!, 'postMessage', { value: posted, configurable: true })
  opened = vi.fn()
  peeked = vi.fn()
  host = hostAppFrame(
    frame,
    { extensionId: 'data-lens', tabId: 'card-1', tabName: 'card', chatId: CHAT, capabilities: ['files:read'], locale: 'en-US', themeMode: 'light', widget: { messageId: 'message-1', data: {}, senderId: 'sender-1' } },
    { showMessage: vi.fn(), showSession: vi.fn(), openWith: opened, peek: peeked, chrome: vi.fn() } as never,
  )
})
afterEach(() => {
  host?.dispose()
  host = undefined
  frame.remove()
  vi.restoreAllMocks()
})

let nextId = 1
async function call(method: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = nextId++
  window.dispatchEvent(new MessageEvent('message', { data: { m: APP_FRAME_MARKER, t: 'call', id, method, args, gesture: true }, source: frame.contentWindow, origin: ORIGIN }))
  await vi.waitFor(() => expect(posted.mock.calls.some(([message]) => (message as { id?: number }).id === id)).toBe(true))
  return posted.mock.calls.map(([message]) => message as Record<string, unknown>).find((message) => message.id === id)!
}
const ref = { chat: CHAT, id: SALES }
const choices = () => opened.mock.calls.map(([detail]) => (detail as { choice: unknown }).choice)
const lensExplore = { kind: 'one', candidate: expect.objectContaining({ extensionId: 'data-lens', tabKind: 'data-lens.explore' }) }

it('a phone page with no own history cannot turn Back into a jump to its opener', async () => {
  host?.dispose()
  const navigate = vi.fn(async () => true)
  host = hostAppFrame(frame, {
    extensionId: 'data-lens', tabId: 'own-page', tabName: 'explore', chatId: CHAT,
    capabilities: ['files:read'], locale: 'en-US', themeMode: 'light',
    navigation: { canBack: false, canForward: false },
  }, { showMessage: vi.fn(), showSession: vi.fn(), openWith: opened, peek: peeked, chrome: vi.fn(), navigate } as never)
  expect(await call('navigationGo', { delta: -1, tabId: 'another-page' })).toMatchObject({ ok: true, value: false })
  expect(navigate).not.toHaveBeenCalled()
})

it('the phone page accepts only a valid delta into an available own history', async () => {
  host?.dispose()
  const navigate = vi.fn(async () => true)
  host = hostAppFrame(frame, {
    extensionId: 'data-lens', tabId: 'own-page', tabName: 'explore', chatId: CHAT,
    capabilities: ['files:read'], locale: 'en-US', themeMode: 'light',
    navigation: { canBack: true, canForward: false },
  }, { showMessage: vi.fn(), showSession: vi.fn(), openWith: opened, peek: peeked, chrome: vi.fn(), navigate } as never)
  expect(await call('navigationGo', { delta: 'back' })).toMatchObject({ ok: false, code: 'invalid' })
  expect(navigate).not.toHaveBeenCalled()
  expect(await call('navigationGo', { delta: -1 })).toMatchObject({ ok: true, value: true })
  expect(navigate).toHaveBeenCalledExactlyOnceWith(-1)
})

it('a phone page holds the back key while it has a step of its own, and gets each press as an event', async () => {
  host?.dispose()
  const claimBack = vi.fn()
  host = hostAppFrame(frame, {
    extensionId: 'data-lens', tabId: 'own-page', tabName: 'explore', chatId: CHAT,
    capabilities: ['files:read'], locale: 'en-US', themeMode: 'light',
  }, { showMessage: vi.fn(), showSession: vi.fn(), openWith: opened, peek: peeked, chrome: vi.fn(), claimBack } as never)
  expect(await call('navigationClaimBack', { claimed: true })).toMatchObject({ ok: true, value: true })
  expect(claimBack).toHaveBeenLastCalledWith(true)
  host.back()
  expect(posted.mock.calls.map(([message]) => message)).toContainEqual(expect.objectContaining({ t: 'event', event: { type: 'back' } }))
  expect(await call('navigationClaimBack', { claimed: false })).toMatchObject({ ok: true, value: true })
  expect(claimBack).toHaveBeenLastCalledWith(false)
  // A new document in the frame lets go of what the old one held.
  claimBack.mockClear()
  window.dispatchEvent(new MessageEvent('message', { data: { m: APP_FRAME_MARKER, t: 'hello' }, source: frame.contentWindow, origin: ORIGIN }))
  await vi.waitFor(() => expect(claimBack).toHaveBeenCalledWith(false))
})

describe('the phone: openWith(file, { tab }) opens its own tab (A2 T9)', () => {
  it.each(['navigate', 'newTab', 'beside'] as const)('folder redesign carries %s through the real phone host', async (intent) => {
    expect(await call('filesOpenWith', { ref, tab: 'explore', intent })).toMatchObject({ ok: true })
    expect(opened).toHaveBeenCalledWith(expect.objectContaining({ intent, choice: lensExplore }))
  })

  it.each(['navigate', 'newTab', 'beside'] as const)('keeps %s when opening beside the phone page', async (intent) => {
    expect(await call('filesOpenWith', { ref, tab: 'explore', intent, peek: true })).toMatchObject({ ok: true })
    expect(peeked).toHaveBeenCalledWith({ kind: 'chat', detail: expect.objectContaining({ intent, choice: lensExplore }) })
    expect(opened).not.toHaveBeenCalled()
  })

  it('folder redesign defaults to navigation and refuses an invalid intent before opening', async () => {
    expect(await call('filesOpenWith', { ref, tab: 'explore' })).toMatchObject({ ok: true })
    expect(opened).toHaveBeenCalledWith(expect.objectContaining({ intent: 'navigate' }))
    opened.mockClear()
    expect(await call('filesOpenWith', { ref, intent: 'permanent' })).toMatchObject({ ok: false, code: 'invalid' })
    expect(opened).not.toHaveBeenCalled()
  })

  it('T9/T3: both Apps open .xlsx — its own explore opens, nobody is asked', async () => {
    expect(await call('filesOpenWith', { ref, tab: 'explore' })).toMatchObject({ ok: true })
    expect(choices()).toEqual([lensExplore])
  })

  it('T9/T4: 「始终用它」 is Office — its own tab still, and the remembered choice is neither read nor changed', async () => {
    remembered = { 'chat:.xlsx': 'office.sheet' }
    vi.mocked(phoneApps.remembered).mockClear()
    expect(await call('filesOpenWith', { ref, tab: 'explore' })).toMatchObject({ ok: true })
    expect(choices()).toEqual([lensExplore])
    expect(remembered).toEqual({ 'chat:.xlsx': 'office.sheet' })
    expect(phoneApps.remembered).not.toHaveBeenCalled()
  })

  it('T9/T5 (control): without tab, the remembered Office; none remembered, the person picks', async () => {
    remembered = { 'chat:.xlsx': 'office.sheet' }
    expect(await call('filesOpenWith', { ref })).toMatchObject({ ok: true })
    remembered = {}
    expect(await call('filesOpenWith', { ref })).toMatchObject({ ok: true })
    expect(choices()).toEqual([
      { kind: 'one', candidate: expect.objectContaining({ tabKind: 'office.sheet' }) },
      expect.objectContaining({ kind: 'choose' }),
    ])
  })

  it.each([
    ['its own tab that does not claim it', { tab: 'card' }],
    ['another App\'s tab', { tab: 'office.sheet' }],
    ['another App\'s bare tab name', { tab: 'sheet' }],
    ['a forged caller id', { extensionId: 'office', tab: 'sheet' }],
    ['an empty name', { tab: '' }],
    ['a null name', { tab: null }],
    ['not a name', { tab: 42 }],
    ['tab with ask', { tab: 'explore', ask: true }],
  ])('T9/T6: %s — invalid, nothing opened', async (_name, options) => {
    expect(await call('filesOpenWith', { ref, ...options })).toMatchObject({ ok: false, code: 'invalid' })
    expect(opened).not.toHaveBeenCalled()
  })
})
