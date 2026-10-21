// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BRIDGE_VERBS, gestureRefusal } from '../../../../apps/desktop/src/session/shared/extensions/bridge-protocol'

/**
 * L11 B4: which verbs need the person's gesture is a column of `BRIDGE_VERBS`, checked once — where the preload's
 * `call()` takes every verb — and refused in one sentence (`gestureRefusal`). Outside a gesture nothing reaches main.
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
const preload = await import('../../../../apps/desktop/electron/extension-bridge-preload')

type Host = {
  getContext(): Promise<unknown>
  showMessage(id: string): Promise<unknown>
  showSession(id: string): Promise<unknown>
  compose(text: string, where: { chat: string }): Promise<unknown>
  clipboard: { writeText(text: string): Promise<unknown> }
  appFiles: Record<'openWith' | 'upload' | 'download', (args: unknown) => Promise<unknown>>
  forum: Record<'post' | 'reply' | 'react' | 'remove' | 'block' | 'assign' | 'award', (...args: unknown[]) => Promise<unknown>>
}
const host = electron.exposed.__guguHost as Host

/** Each verb that needs a gesture, called the way `window.gugu` calls it. */
const gestureCalls: Record<string, () => Promise<unknown>> = {
  filesOpenWith: () => host.appFiles.openWith({ ref: { chat: 'chat-1', name: 'a.md' } }),
  filesUpload: () => host.appFiles.upload({}),
  filesDownload: () => host.appFiles.download({ ref: { chat: 'chat-1', name: 'a.md' } }),
  showMessage: () => host.showMessage('msg-1'),
  showSession: () => host.showSession('s-1'),
  compose: () => host.compose('picked', { chat: 'chat-1' }),
  clipboardWriteText: () => host.clipboard.writeText('hi'),
  forumPost: () => host.forum.post({ title: 't', body: 'b' }),
  forumReply: () => host.forum.reply('0b000000-0000-4000-8000-000000000002', 'hi'),
  forumReact: () => host.forum.react({ kind: 'post', id: '0b000000-0000-4000-8000-000000000002', emoji: '👍', on: true }),
  forumRemove: () => host.forum.remove({ reply: '0d000000-0000-4000-8000-000000000004' }),
  forumBlock: () => host.forum.block('user:0c000000-0000-4000-8000-000000000003', true),
  forumAssign: () => host.forum.assign('0b000000-0000-4000-8000-000000000002'),
  forumAward: () => host.forum.award('0b000000-0000-4000-8000-000000000002', []),
  // not on window.gugu: the preload's own, for a link of gugu's the person clicked in the page
  openLink: () => preload.openClickedLink('gugu://ext/radar/radar'),
}

const methodsSent = () => electron.invoke.mock.calls.map(([, request]) => (request as { method: string }).method)

describe('a verb that needs a gesture is refused at the one entry, in one sentence (L11 B4)', () => {
  beforeEach(() => {
    electron.invoke.mockClear()
  })

  it('the table says which verbs — every one of them is called here', () => {
    const marked = Object.entries(BRIDGE_VERBS).filter(([, facts]) => 'gesture' in facts).map(([verb]) => verb)
    expect(marked.sort()).toEqual(Object.keys(gestureCalls).sort())
  })

  it('outside a gesture: each is refused with the same sentence, and main hears nothing', async () => {
    activation.isActive = false
    for (const [verb, callIt] of Object.entries(gestureCalls)) await expect(callIt()).rejects.toEqual(gestureRefusal(verb))
    expect(electron.invoke).not.toHaveBeenCalled()
  })

  it('control: inside a gesture each reaches main; outside one, a verb without the mark does, and so does upload with bytes', async () => {
    activation.isActive = true
    for (const callIt of Object.values(gestureCalls)) await expect(callIt()).resolves.toBe('done')
    expect(methodsSent()).toEqual(Object.keys(gestureCalls))
    electron.invoke.mockClear()
    activation.isActive = false
    await expect(host.getContext()).resolves.toBe('done')
    await expect(host.appFiles.upload({ files: [{ name: 'a.txt', bytes: new Uint8Array() }] })).resolves.toBe('done')
    expect(methodsSent()).toEqual(['getContext', 'filesUpload'])
  })
})
