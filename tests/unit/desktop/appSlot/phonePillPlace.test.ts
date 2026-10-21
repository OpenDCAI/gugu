// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { holdPlaceForOpeningPage, hostAppFrame } from '../../../../apps/desktop/src/components/appSlot/phoneAppHost'
import { APP_FRAME_MARKER } from '../../../../apps/desktop/src/session/shared/extensions/app-runtime-protocol'
import type { FileOpenerCandidate } from '../../../../apps/desktop/src/session/shared/extensions/file-openers'
import { until } from '../../../support/awaitCondition'

/**
 * App 引用 pill, the phone's half (148 17:21): a pill opens its file; the App that opens it is told the place as the one
 * `link` event a gugu link brings — here by the phone's host, when that page first asks for its context (main does it on
 * the desktop). Only that App's page of that file in that chat, once; in the order the places came (复核 71c15165 要改 1).
 */

const ORIGIN = 'https://office.acct.apps.gugu.invalid'
// Signed in (the token names who: {"sub":"person-1"}), and the chat a page is on reads as a group with nobody listed — so
// a page moved to another file is told its context, as on a phone, and what follows it can be waited for.
vi.mock('../../../../apps/desktop/src/lib/sessionPublication', () => ({ getRendererAccessToken: () => 'h.eyJzdWIiOiJwZXJzb24tMSJ9.s' }))
vi.mock('@gugu/core/cloud/supabase', () => ({
  createGuguSupabaseClient: () => ({
    from: (table: string) => {
      let id: unknown = null
      const query = {
        select: () => query,
        eq: (column: string, value: unknown) => {
          if (column === 'id') id = value
          return query
        },
        in: () => query,
        order: () => query,
        maybeSingle: async () => ({ data: table === 'chats' ? { id, kind: 'group', name: 'g', source_chat_id: null } : null, error: null }),
        then: (resolve: (value: unknown) => void) => resolve({ data: [], error: null }),
      }
      return query
    },
  }),
}))

const office: FileOpenerCandidate = { extensionId: 'office', tabKind: 'office.main', tabTitle: 'Office', app: { name: '咕咕办公' }, onlyTab: true, suffix: '.pptx' }

let frame: HTMLIFrameElement
let posted: ReturnType<typeof vi.fn>
let host: ReturnType<typeof hostAppFrame> | undefined
const binding = (extensionId: string, chatId: string, itemId: string) =>
  ({ extensionId, tabId: 'tab-1', chatId, itemId, capabilities: ['files:read'] as const, locale: 'en-US', themeMode: 'light' as const })
function start(extensionId: string, chatId: string, itemId = 'item-1') {
  host?.dispose()
  host = hostAppFrame(
    frame,
    binding(extensionId, chatId, itemId),
    { showMessage: vi.fn(), showSession: () => ({ shown: true }), openWith: vi.fn(), chrome: vi.fn() },
  )
}
// Each case starts with what an earlier one left held already expired (held 30 s): only the clock is faked.
beforeAll(() => vi.useFakeTimers({ toFake: ['Date'] }))
beforeEach(() => {
  vi.setSystemTime(Date.now() + 60_000)
  frame = document.createElement('iframe')
  frame.src = `${ORIGIN}/index.html`
  document.body.appendChild(frame)
  posted = vi.fn()
  Object.defineProperty(frame.contentWindow!, 'postMessage', { value: posted, configurable: true })
})
afterEach(() => {
  host?.dispose()
  host = undefined
  frame.remove()
})

let nextId = 1
async function getContext(): Promise<void> {
  const id = nextId++
  window.dispatchEvent(new MessageEvent('message', { data: { m: APP_FRAME_MARKER, t: 'call', id, method: 'getContext', args: {} }, source: frame.contentWindow, origin: ORIGIN }))
  await until(`getContext ${id} answered`, () => posted.mock.calls.some(([message]) => (message as { id?: number }).id === id))
}
const events = (type: string) =>
  posted.mock.calls.map(([message]) => message as { t?: string; event?: { type: string } }).filter((message) => message.t === 'event' && message.event?.type === type).map((message) => message.event)
const linkEvents = () => events('link')

describe('a pill opens its file on the phone: the App that opens it is told the place (App 引用 pill)', () => {
  it('as a link event, when its page first asks for its context — once', async () => {
    holdPlaceForOpeningPage('chat-1', 'item-1', office, { slide: '3', shape: '12' })
    start('office', 'chat-1')
    await getContext()
    expect(linkEvents()).toEqual([{ type: 'link', tab: 'main', path: '', query: { slide: '3', shape: '12' }, file: 'item-1' }])
    await getContext()
    expect(linkEvents()).toHaveLength(1)
  })

  it('control: another App, the same App in another chat, or a page of another file of that chat, is not told', async () => {
    holdPlaceForOpeningPage('chat-2', 'item-1', office, { slide: '5', shape: '7' })
    start('board', 'chat-2')
    await getContext()
    start('office', 'chat-9')
    await getContext()
    start('office', 'chat-2', 'item-other')
    await getContext()
    expect(linkEvents()).toEqual([])
    // …and it is still there for the page it was for.
    start('office', 'chat-2')
    await getContext()
    expect(linkEvents()).toEqual([{ type: 'link', tab: 'main', path: '', query: { slide: '5', shape: '7' }, file: 'item-1' }])
  })

  it('pill A, then pill B, only B’s page opens: B is told B’s place alone; two of one file come oldest first', async () => {
    holdPlaceForOpeningPage('chat-3', 'deck-a', office, { slide: '3' })
    holdPlaceForOpeningPage('chat-3', 'deck-b', office, { slide: '5' })
    holdPlaceForOpeningPage('chat-3', 'deck-b', office, { slide: '6' })
    start('office', 'chat-3', 'deck-b')
    await getContext()
    expect(linkEvents()).toEqual([{ type: 'link', tab: 'main', path: '', query: { slide: '5' }, file: 'deck-b' }, { type: 'link', tab: 'main', path: '', query: { slide: '6' }, file: 'deck-b' }])
  })

  it('a page moved to the pill’s file (the slot handed another file) is told; moved elsewhere, it is not', async () => {
    start('office', 'chat-4', 'sheet')
    await getContext()
    holdPlaceForOpeningPage('chat-4', 'deck-a', office, { slide: '4' })
    const told = events('context').length
    host!.update(binding('office', 'chat-4', 'deck-b'))
    // The move tells the page its context once the chat is read again; a place for it would follow in the same step.
    await until('the move to deck-b told the page its context', () => events('context').length > told)
    expect(linkEvents()).toEqual([])
    host!.update(binding('office', 'chat-4', 'deck-a'))
    await until('the move to deck-a brought its place', () => linkEvents().length > 0)
    expect(linkEvents()).toEqual([{ type: 'link', tab: 'main', path: '', query: { slide: '4' }, file: 'deck-a' }])
  })
})
