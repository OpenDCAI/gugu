// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BRIDGE_VERBS, callRefusal, gestureRefusal, needsGesture } from '../../../../apps/desktop/src/session/shared/extensions/bridge-protocol'

/**
 * L11 B4: which verbs need the person's gesture is a column of `BRIDGE_VERBS`, judged once (`callRefusal`, in main on
 * the desktop, in the host on the phone) and refused in one sentence (`gestureRefusal`). What it judges is a fact read
 * where no page script reaches: on the desktop the preload reads the page's activation as each call leaves it and
 * sends it with the call; the page has no way to set it.
 */

const electron = vi.hoisted(() => ({
  exposed: {} as Record<string, unknown>,
  invoke: vi.fn(async (_channel: string, _request: unknown) => ({ ok: true, value: 'done' })),
}))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (name: string, api: unknown) => void (electron.exposed[name] = api) },
  ipcRenderer: { invoke: electron.invoke, on: () => undefined, removeListener: () => undefined, sendSync: () => 'light' },
}))

const activation = { isActive: false }
Object.defineProperty(navigator, 'userActivation', { value: activation, configurable: true })
await import('../../../../apps/desktop/electron/extension-bridge-preload')

type Host = {
  getContext(): Promise<unknown>
  openLink(url: string): Promise<unknown>
  showMessage(id: string): Promise<unknown>
  showSession(id: string): Promise<unknown>
  dispatch(text: string, options?: Record<string, unknown>): Promise<unknown>
  clipboard: { writeText(text: string): Promise<unknown> }
  appFiles: Record<'openWith' | 'upload' | 'download' | 'forward', (args: unknown) => Promise<unknown>>
  forum: Record<'post' | 'reply' | 'react' | 'remove' | 'block' | 'assign' | 'award', (...args: unknown[]) => Promise<unknown>>
}
const host = electron.exposed.__guguHost as Host

/** Each verb that needs a gesture, called the way `window.gugu` calls it. */
const gestureCalls: Record<string, () => Promise<unknown>> = {
  filesOpenWith: () => host.appFiles.openWith({ ref: { chat: 'chat-1', name: 'a.md' } }),
  filesUpload: () => host.appFiles.upload({}),
  filesDownload: () => host.appFiles.download({ ref: { chat: 'chat-1', name: 'a.md' } }),
  filesForward: () => host.appFiles.forward({ refs: [{ chat: 'chat-1', name: 'a.md' }] }),
  showMessage: () => host.showMessage('msg-1'),
  showSession: () => host.showSession('s-1'),
  dispatch: () => host.dispatch('picked'),
  clipboardWriteText: () => host.clipboard.writeText('hi'),
  forumPost: () => host.forum.post({ title: 't', body: 'b' }),
  forumReply: () => host.forum.reply('0b000000-0000-4000-8000-000000000002', 'hi'),
  forumReact: () => host.forum.react({ kind: 'post', id: '0b000000-0000-4000-8000-000000000002', emoji: '👍', on: true }),
  forumRemove: () => host.forum.remove({ reply: '0d000000-0000-4000-8000-000000000004' }),
  forumBlock: () => host.forum.block('user:0c000000-0000-4000-8000-000000000003', true),
  forumAssign: () => host.forum.assign('0b000000-0000-4000-8000-000000000002'),
  forumAward: () => host.forum.award('0b000000-0000-4000-8000-000000000002', []),
  openLink: () => host.openLink('gugu://ext/radar/radar'),
}

const sent = () => electron.invoke.mock.calls.map(([, request]) => request as { method: string; gesture: unknown })

describe('a verb that needs a gesture is judged by one rule, on what the preload read (L11 B4)', () => {
  beforeEach(() => {
    electron.invoke.mockClear()
  })

  it('the table says which verbs — every one of them is called here', () => {
    const marked = Object.entries(BRIDGE_VERBS).filter(([, facts]) => 'gesture' in facts).map(([verb]) => verb)
    expect(marked.sort()).toEqual(Object.keys(gestureCalls).sort())
  })

  it('the preload sends each call with the activation it read as the call left the page, never the page\'s word', async () => {
    for (const active of [false, true]) {
      electron.invoke.mockClear()
      activation.isActive = active
      for (const callIt of Object.values(gestureCalls)) await callIt()
      expect(sent().map(({ method }) => method)).toEqual(Object.keys(gestureCalls))
      expect(sent().every(({ gesture }) => gesture === active)).toBe(true)
    }
    // An argument named like it is the page's data, not the reading.
    activation.isActive = false
    electron.invoke.mockClear()
    await host.dispatch('picked', { gesture: true })
    expect(sent()[0]!.gesture).toBe(false)
  })

  it('callRefusal: outside a gesture each is refused in the same sentence; inside one, and for an unmarked call, it is not', () => {
    const has = () => true
    for (const verb of Object.keys(gestureCalls)) {
      const args = verb === 'filesUpload' ? { pick: true } : {}
      expect(callRefusal(verb, args, { kind: 'page', has, gesture: false })).toEqual(gestureRefusal(verb))
      expect(callRefusal(verb, args, { kind: 'page', has, gesture: true })).toBeNull()
    }
    // Upload with bytes and a dispatch naming its target need none; a program never has one.
    expect(needsGesture('filesUpload', { files: [] })).toBe(false)
    expect(callRefusal('dispatch', { text: 'hi', to: { agent: 'user:0a000000-0000-4000-8000-000000000001' } }, { kind: 'page', has, gesture: false })).toBeNull()
    expect(callRefusal('clipboardWriteText', {}, { kind: 'program', has })).toMatchObject({ code: 'invalid' })
  })
})
