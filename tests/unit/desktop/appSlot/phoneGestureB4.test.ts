// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hostAppFrame, type PhoneAppBinding } from '../../../../apps/desktop/src/components/appSlot/phoneAppHost'
import { PHONE_CAPABILITIES } from '../../../../apps/desktop/src/components/appSlot/phoneApps'
import { grantableBy } from '../../../../apps/desktop/src/session/shared/extensions/attachment-install'
import { APP_COMPOSE_EVENT, APP_FRAME_MARKER } from '../../../../apps/desktop/src/session/shared/extensions/app-runtime-protocol'
import { BRIDGE_VERBS, gestureRefusal } from '../../../../apps/desktop/src/session/shared/extensions/bridge-protocol'
import { EXTENSION_API_VERSION, parseExtensionManifest } from '../../../../apps/desktop/src/session/shared/extensions/manifest'

/**
 * L11 B4, the phone's half (B3 made its entry read the same column): a verb that needs the person's gesture, called
 * outside one, is refused where the call arrives — in the sentence the desktop's preload says (`gestureRefusal`,
 * extensionBridgeGestureB4.test.ts), not a phone wording of its own.
 */

const ORIGIN = 'https://board.acct.apps.gugu.invalid'
/** The chat compose names: one the person signed in to this page is in (`composeInChat` reads it as them). */
const CHAT = '0b000000-0000-4000-8000-0000000000b4'
const DECK = '0c000000-0000-4000-8000-0000000000b4'
const auth = vi.hoisted(() => ({ token: `h.${Buffer.from(JSON.stringify({ sub: '0a000000-0000-4000-8000-0000000000b4' })).toString('base64url')}.s` }))
vi.mock('../../../../apps/desktop/src/lib/sessionPublication', () => ({ getRendererAccessToken: () => auth.token }))
vi.mock('@gugu/core/cloud/supabase', () => ({
  createGuguSupabaseClient: () => {
    const query = {
      select: () => query,
      eq: () => query,
      maybeSingle: async () => ({ data: { id: CHAT }, error: null }),
      // The file a compose's refs point at (App 引用 pill), read as the person.
      in: async () => ({ data: [{ id: DECK, chat_id: CHAT, filename: 'deck.pptx', version: 3 }], error: null }),
    }
    // The folder's doors, as the person: the deck by its id, who may delete what (everyone, everything).
    // (Built when asked: this client is made while the module loads, before DECK is.)
    const rpc = async (name: string, args: Record<string, unknown>) =>
      name === 'chat_facts'
        ? { data: [{ id: args.p_chat_id, kind: 'group', source_chat_id: null }], error: null }
        : name === 'workspace_deletable_as'
        ? { data: args.p_item_ids, error: null }
        : { data: [{ id: DECK, chat_id: CHAT, kind: 'file', filename: 'deck.pptx', version: 3, parent_id: null, system_role: null, path: 'deck.pptx' }], error: null }
    return { from: () => query, rpc }
  },
}))
const activation = { isActive: false }
/** The task tab's list, as the slot reads it for `showSession`: what it answers, and which sessions were asked for. */
const taskList = { answer: { shown: true } as { shown: true } | { unread: string[] }, asked: [] as string[] }
Object.defineProperty(navigator, 'userActivation', { value: activation, configurable: true })

let frame: HTMLIFrameElement
let posted: ReturnType<typeof vi.fn>
let host: ReturnType<typeof hostAppFrame> | undefined
function start(capabilities: PhoneAppBinding['capabilities']) {
  host?.dispose()
  host = hostAppFrame(
    frame,
    { extensionId: 'board', tabId: 'tab-1', tabName: 'main', chatId: 'chat-1', capabilities, locale: 'en-US', themeMode: 'light' },
    {
      showMessage: vi.fn(),
      showSession: (sessionId: string) => {
        taskList.asked.push(sessionId)
        return taskList.answer
      },
      openWith: vi.fn(),
      chrome: vi.fn(),
    },
  )
}
beforeEach(() => {
  frame = document.createElement('iframe')
  frame.src = `${ORIGIN}/index.html`
  document.body.appendChild(frame)
  posted = vi.fn()
  Object.defineProperty(frame.contentWindow!, 'postMessage', { value: posted, configurable: true })
  start(['files:read', 'files:write'])
})
afterEach(() => {
  host?.dispose()
  host = undefined
  vi.unstubAllGlobals()
  frame.remove()
})

let nextId = 1
/** A call as the App's runtime posts it from its own document; its answer as the host posts it back. */
async function call(method: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = nextId++
  window.dispatchEvent(new MessageEvent('message', { data: { m: APP_FRAME_MARKER, t: 'call', id, method, args }, source: frame.contentWindow, origin: ORIGIN }))
  await vi.waitFor(() => expect(posted.mock.calls.some(([message]) => (message as { id?: number }).id === id)).toBe(true))
  return posted.mock.calls.map(([message]) => message as Record<string, unknown>).find((message) => message.id === id)!
}

/** Each verb that needs a gesture, with the arguments a page gives it. */
const gestureCalls: Record<string, Record<string, unknown>> = {
  filesOpenWith: { ref: { name: 'a.md' } },
  filesUpload: { pick: true },
  filesDownload: { ref: { name: 'a.md' } },
  showMessage: { id: 'msg-1' },
  showSession: { id: 's-1' },
  dispatch: { text: 'picked' },
  clipboardWriteText: { text: 'hi' },
  openLink: { url: 'gugu://ext/radar/radar' },
  forumPost: { title: 't', body: 'b' },
  forumReply: { postId: '0b000000-0000-4000-8000-000000000002', text: 'hi' },
  forumReact: { kind: 'post', id: '0b000000-0000-4000-8000-000000000002', emoji: '👍', on: true },
  forumRemove: { reply: '0d000000-0000-4000-8000-000000000004' },
  forumBlock: { userId: 'user:0c000000-0000-4000-8000-000000000003', on: true },
  forumAssign: { postId: '0b000000-0000-4000-8000-000000000002', agentId: 'user:0a000000-0000-4000-8000-000000000001' },
  forumAward: { postId: '0b000000-0000-4000-8000-000000000002', awards: [] },
}

describe('the phone refuses a verb outside the gesture it needs, in the same sentence as the desktop (L11 B4)', () => {
  it('every verb the table marks is refused with gestureRefusal, before it does anything', async () => {
    expect(Object.keys(gestureCalls).sort()).toEqual(Object.entries(BRIDGE_VERBS).filter(([, facts]) => 'gesture' in facts).map(([verb]) => verb).sort())
    activation.isActive = false
    for (const [verb, args] of Object.entries(gestureCalls)) {
      const { code, message } = gestureRefusal(verb)
      expect(await call(verb, args), verb).toMatchObject({ ok: false, code, message })
    }
  })

  it('control: inside a gesture the clipboard is written; outside one, a verb without the mark answers', async () => {
    const writeText = vi.fn(async (_text: string) => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    activation.isActive = true
    expect(await call('clipboardWriteText', { text: 'hi' })).toMatchObject({ ok: true })
    expect(writeText).toHaveBeenCalledWith('hi')
    activation.isActive = false
    expect(await call('setTabTitle', { title: 'Board' })).toMatchObject({ ok: true })
  })

  it('control: inside a tap, a dispatch draft hands the composer of the chat it names the text — no capability asked, nothing sent', async () => {
    const composed: unknown[] = []
    const take = (event: Event) => {
      expect(event.target).toBe(document)
      expect(event.eventPhase).toBe(Event.BUBBLING_PHASE)
      composed.push((event as CustomEvent).detail)
    }
    window.addEventListener(APP_COMPOSE_EVENT, take)
    activation.isActive = true
    expect(await call('dispatch', { text: '  > picked  ', draft: true, to: { chat: CHAT } })).toMatchObject({ ok: true, value: { to: { chat: CHAT } } })
    // A phone reaches none of the person's agents yet: one named is not here.
    expect(await call('dispatch', { text: 'picked', draft: true, to: { agent: 'user:00000000-0000-4000-8000-000000000009' } })).toMatchObject({ ok: false, code: 'not-found' })
    // App 引用 pill: refs make pills the composer holds, as on the desktop; `about` is gone, said so.
    expect(await call('dispatch', { text: '', draft: true, refs: [{ file: { id: DECK }, at: { slide: 2 }, label: '第 2 页' }] })).toMatchObject({ ok: true })
    expect(await call('dispatch', { text: 'x', draft: true, about: { id: DECK } })).toMatchObject({ ok: false, code: 'invalid' })
    window.removeEventListener(APP_COMPOSE_EVENT, take)
    expect(composed).toEqual([
      { chatId: CHAT, text: '> picked\n' },
      { chatId: CHAT, text: '', refs: [{ label: 'deck.pptx · 第 2 页', link: `gugu-file://${DECK}?v=3#slide=2` }] },
    ])
  })
})

describe("showSession on the phone: the task tab opens the session's row, on whichever of the person's computers", () => {
  beforeEach(() => {
    taskList.answer = { shown: true }
    taskList.asked = []
    activation.isActive = true
  })

  it('listed: the row is opened, and the page is told nothing more', async () => {
    expect(await call('showSession', { id: 's-1' })).toMatchObject({ ok: true })
    expect(taskList.asked).toEqual(['s-1'])
  })

  it('listed nowhere: not-found when every computer was read; failed, naming them, when one was not', async () => {
    taskList.answer = { unread: [] }
    expect(await call('showSession', { id: 's-1' })).toMatchObject({ ok: false, code: 'not-found', message: 'Session s-1 is not in your task list' })
    taskList.answer = { unread: ['Mac Studio'] }
    expect(await call('showSession', { id: 's-1' })).toMatchObject({ ok: false, code: 'failed', message: 'Session s-1 is not in your task list (not read: Mac Studio)' })
  })

  it('one spelling, as on the desktop: an address is invalid and the list is not even asked', async () => {
    expect(await call('showSession', { id: 'user:0a000000-0000-4000-8000-0000000000b4' })).toMatchObject({ ok: false, code: 'invalid' })
    expect(await call('showSession', {})).toMatchObject({ ok: false, code: 'invalid' })
    expect(taskList.asked).toEqual([])
  })
})

describe('the phone refuses a verb whose capability the App lacks, as the desktop does (S15)', () => {
  it('a dispatch naming a member without chat:relay is denied, naming the capability, before anything is sent', async () => {
    expect(await call('dispatch', { to: { chat: CHAT, member: 'user:00000000-0000-4000-8000-000000000001' }, text: 'hi' })).toMatchObject({
      ok: false,
      code: 'denied',
      message: 'Not permitted: this App does not have "chat:relay"',
    })
  })

  it('control: with chat:relay the same call gets past that gate (whatever happens next, it is not that)', async () => {
    // Past the gate it would reach the database: offline here, so it fails at once — for another reason.
    vi.stubGlobal('fetch', async () => {
      throw new Error('offline')
    })
    start(['files:read', 'files:write', 'chat:relay'])
    const answer = await call('dispatch', { to: { chat: CHAT, member: 'user:00000000-0000-4000-8000-000000000001' }, text: 'hi' })
    expect(answer.message).not.toMatch(/Not permitted/)
  })

  it('files:read:all-machines is kept when installed here and has what files:read gives: its verbs, and a watched chat changing', async () => {
    start(['chat:relay'])
    expect(await call('filesWatch', { watchId: 'source-watch', place: { chat: CHAT } })).toMatchObject({ ok: false, code: 'denied', message: 'Not permitted: this App does not have "files:read"' })
    const manifest = parseExtensionManifest({
      id: 'board',
      name: 'Board',
      version: '1.0.0',
      apiVersion: EXTENSION_API_VERSION,
      entry: 'index.html',
      permissions: { capabilities: ['files:read:all-machines', 'chat:relay'] },
      contributes: { tabs: [{ name: 'main', title: 'Board', opensFiles: { chat: ['.board.json'] } }] },
    })
    const kept = grantableBy(manifest, PHONE_CAPABILITIES).permissions?.capabilities ?? []
    expect(kept).toEqual(['files:read:all-machines', 'chat:relay'])
    start(kept)
    expect(await call('filesWatch', { watchId: 'source-watch', place: { chat: CHAT } })).toMatchObject({ ok: true })
    const filesChanged = () => posted.mock.calls.filter(([message]) => message.t === 'event' && message.event?.type === 'filesChanged')
    await host!.filesChanged([{ chatId: CHAT, itemIds: [DECK] }])
    expect(filesChanged()).toHaveLength(1)
    // A new theme rebinds the frame (update): what the word covers stays.
    host!.update({ extensionId: 'board', tabId: 'tab-1', tabName: 'main', chatId: 'chat-1', capabilities: kept, locale: 'en-US', themeMode: 'dark' })
    await host!.filesChanged([{ chatId: CHAT, itemIds: [DECK] }])
    expect(filesChanged()).toHaveLength(2)
  })
})
