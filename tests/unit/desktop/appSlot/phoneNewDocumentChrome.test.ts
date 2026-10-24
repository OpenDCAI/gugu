// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hostAppFrame } from '../../../../apps/desktop/src/components/appSlot/phoneAppHost'
import { APP_FRAME_MARKER } from '../../../../apps/desktop/src/session/shared/extensions/app-runtime-protocol'

/**
 * 10-19: 论文共读's reader names the slot after its paper (`setTabTitle`); its back button is `location.href = 'shelf.html'`,
 * a new document in the same frame, and the shelf says no title — the slot kept the paper's title over the shelf. What a
 * page says about itself goes with its document: the new document's runtime says `hello` ahead of its first call
 * (framed-host.ts; the frame's `load` comes after the new document's scripts, #7491), and the host takes the old title,
 * badge and error back there — as main's `newDocument` on the desktop. Control (the parent commit): nothing on `hello`.
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
let host: ReturnType<typeof hostAppFrame>
beforeEach(() => {
  frame = document.createElement('iframe')
  frame.src = `${ORIGIN}/reader.html?file=${NOTES}`
  document.body.appendChild(frame)
  Object.defineProperty(frame.contentWindow!, 'postMessage', { value: vi.fn(), configurable: true })
})
afterEach(() => {
  host.dispose()
  frame.remove()
})

function fromFrame(data: Record<string, unknown>): void {
  window.dispatchEvent(new MessageEvent('message', { data: { m: APP_FRAME_MARKER, ...data }, source: frame.contentWindow, origin: ORIGIN }))
}

describe('what a page says about itself goes with its document on the phone too', () => {
  it('reader → shelf: the reader names the slot; the shelf’s hello takes its title, badge and error back', async () => {
    const chrome = vi.fn()
    host = hostAppFrame(frame, { extensionId: 'papers', tabId: 'app-page:papers.shelf', tabName: 'shelf', chatId: CHAT, capabilities: [], locale: 'zh-CN', themeMode: 'dark' }, {
      showMessage: vi.fn(),
      showSession: () => ({ shown: true }),
      openWith: vi.fn(),
      chrome,
    })
    fromFrame({ t: 'hello' })
    chrome.mockClear()
    fromFrame({ t: 'call', id: 1, method: 'setTabTitle', args: { title: 'Attention Is All You Need' } })
    await vi.waitFor(() => expect(chrome).toHaveBeenCalledWith({ title: 'Attention Is All You Need' }))

    // `location.href = 'shelf.html'`: the shelf's runtime starts and says hello before anything else.
    fromFrame({ t: 'hello' })
    expect(chrome).toHaveBeenLastCalledWith({ title: null, badge: null, error: null })
  })
})
