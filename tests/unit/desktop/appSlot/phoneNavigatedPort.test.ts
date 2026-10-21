// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hostAppFrame } from '../../../../apps/desktop/src/components/appSlot/phoneAppHost'
import { APP_FRAME_MARKER, SYNC_PORT_WINDOW_MESSAGE } from '../../../../apps/desktop/src/session/shared/extensions/app-runtime-protocol'

/**
 * An App that moves to another of its own pages inside its frame (論文共読: shelf.html → reader.html?file=…) opens a live
 * file there: the new document gets a sync port of its own. The frame's `load` comes after the new document's scripts —
 * after it opened the file — and the first `load` may come before the host listens, so the new document is told by its
 * runtime's `hello` (framed-host.ts), ahead of its first call. Before: the open reused the old document's page, no port
 * was made, and the reader waited for one until `file-unavailable … (waiting for: port)`.
 */

const ORIGIN = 'https://papers.acct.apps.gugu.invalid'
const CHAT = '0b000000-0000-4000-8000-0000000000aa'
const NOTES = '0f000000-0000-4000-8000-0000000000aa'
const auth = vi.hoisted(() => ({ token: `h.${Buffer.from(JSON.stringify({ sub: '0a000000-0000-4000-8000-0000000000aa' })).toString('base64url')}.s` }))
vi.mock('../../../../apps/desktop/src/lib/sessionPublication', () => ({ getRendererAccessToken: () => auth.token }))
vi.mock('../../../../apps/desktop/src/lib/identityReadAdapter', () => ({ readDisplayIdentities: async () => [] }))
vi.mock('@gugu/core/cloud/supabase', () => ({
  createGuguSupabaseClient: () => {
    const query = { select: () => query, eq: () => query, in: async () => ({ data: [], error: null }), maybeSingle: async () => ({ data: null, error: null }) }
    return {
      from: () => query,
      // The live notes file, as the person reads it by its id; theirs to delete.
      rpc: async (name: string, args: Record<string, unknown>) =>
        name === 'workspace_deletable_as'
          ? { data: args.p_item_ids, error: null }
          : { data: [{ id: NOTES, chat_id: CHAT, kind: 'document', filename: 'notes.json', version: 1, epoch: 1, parent_id: null, system_role: null, path: 'notes.json' }], error: null },
    }
  },
}))

let frame: HTMLIFrameElement
let posted: ReturnType<typeof vi.fn>
let host: ReturnType<typeof hostAppFrame>
beforeEach(() => {
  frame = document.createElement('iframe')
  frame.src = `${ORIGIN}/shelf.html`
  document.body.appendChild(frame)
  posted = vi.fn()
  Object.defineProperty(frame.contentWindow!, 'postMessage', { value: posted, configurable: true })
})
afterEach(() => {
  host.dispose()
  frame.remove()
})

/** What the frame's document posts to the outer page. */
function fromFrame(data: Record<string, unknown>): void {
  window.dispatchEvent(new MessageEvent('message', { data: { m: APP_FRAME_MARKER, ...data }, source: frame.contentWindow, origin: ORIGIN }))
}
let nextId = 1
/** A document opens the notes file, as its runtime does: the call, then asking for the port (sync-link.ts). */
async function openNotes(): Promise<void> {
  const id = nextId++
  fromFrame({ t: 'call', id, method: 'filesOpen', args: { ref: { chat: CHAT, id: NOTES } } })
  await vi.waitFor(() => expect(posted.mock.calls.some(([message]) => (message as { id?: number }).id === id)).toBe(true))
  expect(posted.mock.calls.find(([message]) => (message as { id?: number }).id === id)![0]).toMatchObject({ ok: true })
  fromFrame({ t: 'sync-port' })
}
const portsHandedOver = () => posted.mock.calls.filter(([message, , transfer]) => message === SYNC_PORT_WINDOW_MESSAGE && (transfer as unknown[] | undefined)?.length === 1).length

describe('a page the App moves to in its own frame on the phone gets a sync port of its own', () => {
  it('shelf → reader: the reader opens the live file and its port is handed over (the first load came before the host listened)', async () => {
    // The shelf's document loaded before the host listened: no `load` is seen for it.
    host = hostAppFrame(frame, { extensionId: 'papers', tabId: 'app-page:papers.shelf', chatId: null, capabilities: ['files:read', 'files:write'], locale: 'en-US', themeMode: 'light' }, {
      showMessage: vi.fn(),
      showSession: () => ({ shown: true }),
      openWith: vi.fn(),
      chrome: vi.fn(),
    })
    fromFrame({ t: 'hello' })
    await openNotes()
    expect(portsHandedOver()).toBe(1)

    // `location.href = 'reader.html?file=…'`: the reader's runtime starts, and opens the file before its `load`.
    fromFrame({ t: 'hello' })
    await openNotes()
    frame.dispatchEvent(new Event('load'))
    expect(portsHandedOver()).toBe(2)
  })

  it('control: within one document a second open uses the port it has — none is handed over again', async () => {
    host = hostAppFrame(frame, { extensionId: 'papers', tabId: 'app-page:papers.shelf', chatId: null, capabilities: ['files:read', 'files:write'], locale: 'en-US', themeMode: 'light' }, {
      showMessage: vi.fn(),
      showSession: () => ({ shown: true }),
      openWith: vi.fn(),
      chrome: vi.fn(),
    })
    fromFrame({ t: 'hello' })
    await openNotes()
    await openNotes()
    expect(portsHandedOver()).toBe(1)
  })
})
