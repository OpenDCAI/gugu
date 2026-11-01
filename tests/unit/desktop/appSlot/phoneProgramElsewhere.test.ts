// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APP_FRAME_MARKER } from '../../../../apps/desktop/src/session/shared/extensions/app-runtime-protocol'

/**
 * owner 10-16「程序跟着数据」, the phone: an App page in a session on one of the person's computers calls the App's program on
 * that computer (`agentSession.app_call`), its context says which computer, and what that program sends comes to the
 * page. A page in a chat has no computer: the phone runs no program, so its call is refused.
 */
const ORIGIN = 'https://spexcode.acct.apps.gugu.invalid'
const auth = vi.hoisted(() => ({ token: `h.${Buffer.from(JSON.stringify({ sub: '0a000000-0000-4000-8000-0000000000c1' })).toString('base64url')}.s` }))
vi.mock('../../../../apps/desktop/src/lib/sessionPublication', () => ({ getRendererAccessToken: () => auth.token }))
const sent = vi.hoisted(() => ({ calls: [] as unknown[][], answer: { content: [{ type: 'text', text: 'graph' }] } as unknown, refusal: null as null | { code: string; message: string } }))
vi.mock('../../../../apps/desktop/src/mobile/agent-watch/sessionpage-rpc', () => ({
  appCallOn: async (...args: unknown[]) => {
    sent.calls.push(args)
    if (sent.refusal) throw Object.assign(new Error(sent.refusal.message), { code: sent.refusal.code })
    return sent.answer
  },
}))
const phoneMcp = vi.hoisted(() => ({ servers: [{ tools: 'tools.js' }] as Record<string, string>[] }))
vi.mock('../../../../apps/desktop/src/session/renderer/features/extensions/installed-extensions-store', () => ({
  installedExtensionsStore: {
    manifests: [],
    isEnabled: () => true,
    manifestFor: (id: string) => (id === 'spexcode' ? { id, name: 'SpexCode', version: '0.7.0', contributes: { tabs: [], mcpServers: phoneMcp.servers } } : undefined),
    icons: {},
  },
}))
// The phone's own App data store (the shell's), for a page in a chat.
const own = vi.hoisted(() => ({ read: vi.fn(async () => 'phone') }))
vi.mock('../../../../apps/desktop/src/components/appSlot/phoneApps', async (original) => {
  const real = await original<typeof import('../../../../apps/desktop/src/components/appSlot/phoneApps')>()
  return { ...real, phoneApps: { ...real.phoneApps, data: { ...real.phoneApps.data, read: own.read } } }
})
vi.mock('../../../../apps/desktop/src/session/shared/remote-sessions/session-directory', async (original) => ({
  ...await original<typeof import('../../../../apps/desktop/src/session/shared/remote-sessions/session-directory')>(),
  listedSession: (_devices: unknown, _live: unknown, id: string) => id === 's-there'
    ? { row: { deviceId: 'dev-server', session: { conversationId: id, projectId: 'p-2' } } } : { unread: [] },
}))
const openWorkingCopy = vi.fn()
const { hostAppFrame } = await import('../../../../apps/desktop/src/components/appSlot/phoneAppHost')

let frame: HTMLIFrameElement
let posted: ReturnType<typeof vi.fn>
let host: ReturnType<typeof hostAppFrame> | undefined
const SESSION: { id: string; deviceId: string; deviceLabel: string; projectId: string; online?: boolean } = { id: 's-there', deviceId: 'dev-server', deviceLabel: 'server', projectId: 'p-2' }
function start(where: { chatId: string | null; session?: typeof SESSION }) {
  host?.dispose()
  host = hostAppFrame(frame, { extensionId: 'spexcode', tabId: 'tab-1', tabName: 'main', ...where, capabilities: ['files:read'], locale: 'en-US', themeMode: 'light' }, {
    showMessage: vi.fn(), showSession: () => ({ shown: true }), openWith: vi.fn(), openWorkingCopy, chrome: vi.fn(),
  })
}
beforeEach(() => {
  frame = document.createElement('iframe')
  frame.src = `${ORIGIN}/index.html`
  document.body.appendChild(frame)
  posted = vi.fn()
  Object.defineProperty(frame.contentWindow!, 'postMessage', { value: posted, configurable: true })
  sent.calls.length = 0
  sent.refusal = null
  openWorkingCopy.mockClear()
  sent.answer = { content: [{ type: 'text', text: 'graph' }] }
})
afterEach(() => {
  host?.dispose()
  host = undefined
  frame.remove()
  vi.unstubAllGlobals()
})

let nextId = 1
async function call(method: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = nextId++
  window.dispatchEvent(new MessageEvent('message', { data: { m: APP_FRAME_MARKER, t: 'call', id, method, args }, source: frame.contentWindow, origin: ORIGIN }))
  await vi.waitFor(() => expect(posted.mock.calls.some(([message]) => (message as { id?: number }).id === id)).toBe(true))
  return posted.mock.calls.map(([message]) => message as Record<string, unknown>).find((message) => message.id === id)!
}

describe('an App page on the phone, in a session on another computer', () => {
  it('opens a working-copy file in the phone preview through the same machine route as listing', async () => {
    vi.stubGlobal('navigator', { userActivation: { isActive: true } })
    start({ chatId: null, session: SESSION })
    sent.answer = { size: 18, offset: 0, etag: 'v1', data: 'YQ==' }
    const ref = { workspace: 'session:s-there', id: 'notes/a.md' }
    expect(await call('filesOpenWith', { ref })).toMatchObject({ ok: true })
    expect(sent.calls[0]).toMatchObject(['dev-server', { extensionId: 'spexcode' }, { method: 'filesRead', session_id: 's-there', args: { ref, offset: 0, length: 1 } }])
    expect(openWorkingCopy).toHaveBeenCalledWith('notes/a.md', expect.any(Function))
    const read = openWorkingCopy.mock.calls[0]![1] as (offset: number, length: number) => Promise<unknown>
    await expect(read(1, 17)).resolves.toMatchObject({ size: 18, etag: 'v1' })
    expect(sent.calls[1]).toMatchObject(['dev-server', expect.anything(), { method: 'filesRead', args: { ref, offset: 1, length: 17 } }])
    openWorkingCopy.mockClear()
    sent.refusal = { code: 'not-found', message: 'file missing' }
    expect(await call('filesOpenWith', { ref, ask: true })).toMatchObject({ ok: false, code: 'not-found' })
    expect(openWorkingCopy).not.toHaveBeenCalled()
  })

  it('calls its program on that computer, with this App\'s version, under one caller id kept for this install', async () => {
    start({ chatId: null, session: SESSION })
    expect(await call('callProgram', { name: 'graph', arguments: { a: 1 } })).toMatchObject({ ok: true, value: { content: [{ text: 'graph' }] } })
    await call('callProgram', { name: 'node' })
    const [[deviceId, caller, action], [, again]] = sent.calls as [[string, Record<string, unknown>, Record<string, unknown>], [string, Record<string, unknown>]]
    expect(deviceId).toBe('dev-server')
    expect(caller).toMatchObject({ kind: 'app', deviceLabel: 'phone', extensionId: 'spexcode', extensionName: 'SpexCode' })
    expect(again.deviceId).toBe(caller.deviceId)
    expect(action).toMatchObject({ action: 'app_call', session_id: 's-there', version: '0.7.0', method: 'callProgram', args: { name: 'graph', arguments: { a: 1 } } })
    expect(typeof action.call_id).toBe('string')
  })

  it('reads and writes the App\'s data folder on that computer, where its program keeps it (161 10-16「地方决定机器」)', async () => {
    start({ chatId: null, session: SESSION })
    sent.calls.length = 0
    sent.refusal = null
    // That computer's answer, whole: one call each way.
    sent.answer = '{"days":{}}'
    expect(await call('readData', { path: 'journal.json' })).toMatchObject({ ok: true, value: '{"days":{}}' })
    await call('writeData', { path: 'journal.json', content: '{}' })
    const [read, write] = sent.calls.map(([deviceId, , action]) => [deviceId, action]) as [string, Record<string, unknown>][]
    expect(read).toEqual(['dev-server', expect.objectContaining({ action: 'app_call', session_id: 's-there', version: '0.7.0', method: 'readData', args: { path: 'journal.json' } })])
    expect(write).toEqual(['dev-server', expect.objectContaining({ action: 'app_call', session_id: 's-there', version: '0.7.0', method: 'writeData', args: { path: 'journal.json', content: '{}' } })])
    expect(sent.calls).toHaveLength(2)
    // Over 1 MB it is not sent: the file says it is too large across machines (owner 10-17), never cut.
    expect(await call('writeData', { path: 'big.json', content: 'x'.repeat(1024 * 1024) })).toMatchObject({
      ok: false, code: 'too-large', message: expect.stringMatching(/^big\.json is 1025 KB; a page reads and writes a data file on another machine up to 1 MB/),
    })
    expect(sent.calls).toHaveLength(2)
    expect(own.read).not.toHaveBeenCalled()
    // In a chat the phone's own store, as before.
    start({ chatId: '0b000000-0000-4000-8000-0000000000aa' })
    expect(await call('readData', { path: 'journal.json' })).toMatchObject({ ok: true, value: 'phone' })
    expect(sent.calls).toHaveLength(2)
    sent.answer = { content: [{ type: 'text', text: 'graph' }] }
  })

  it('passes that computer\'s refusal on with its code, and reads a computer too old as unavailable', async () => {
    start({ chatId: null, session: SESSION })
    sent.refusal = { code: 'version-mismatch', message: 'SpexCode is 0.6.0 on this machine and 0.7.0 where its page is' }
    // The phone names that computer: "this machine" in its words is not the phone.
    expect(await call('callProgram', { name: 'graph' })).toMatchObject({ ok: false, code: 'version-mismatch', message: 'on "server": SpexCode is 0.6.0 on this machine and 0.7.0 where its page is' })
    sent.refusal = { code: 'unknown_method', message: 'unknown method' }
    expect(await call('callProgram', { name: 'graph' })).toMatchObject({ ok: false, code: 'unavailable' })
  })

  it('a program gugu hosts (Browser Use) drives the screen the page is on — a phone hosts none: invalid, nothing sent (161 10-17)', async () => {
    start({ chatId: null, session: SESSION })
    sent.calls.length = 0
    phoneMcp.servers = [{ name: 'browser', host: 'browser-use' }]
    expect(await call('callProgram', { name: 'open' })).toMatchObject({ ok: false, code: 'invalid' })
    expect(sent.calls).toHaveLength(0)
    phoneMcp.servers = [{ tools: 'tools.js' }]
  })

  it('a computer the phone shows offline is not asked: unavailable at once, nothing sent', async () => {
    start({ chatId: null, session: { ...SESSION, online: false } })
    sent.calls.length = 0
    expect(await call('callProgram', { name: 'graph' })).toMatchObject({ ok: false, code: 'unavailable', message: '"server" is offline; nothing was sent there' })
    expect(sent.calls).toHaveLength(0)
  })

  it('its context names the working copy (the session) and its computer, and no chat', async () => {
    start({ chatId: null, session: SESSION })
    const context = (await call('getContext', {})).value as Record<string, unknown>
    expect(context.workspace).toEqual({ id: 'session:s-there', sessionId: 's-there', deviceId: 'dev-server', deviceLabel: 'server', projectId: 'p-2' })
    expect(context).not.toHaveProperty('chat')
  })

  it('what the program there sends comes to the page', () => {
    start({ chatId: null, session: SESSION })
    host!.programNotified({ server: 'tools', method: 'notifications/spec/changed', params: { at: 1 } })
    expect(posted.mock.calls.map(([message]) => message)).toContainEqual({
      m: APP_FRAME_MARKER, t: 'event', event: { type: 'programNotification', server: 'tools', method: 'notifications/spec/changed', params: { at: 1 } },
    })
  })
})

describe('an App page on the phone, in a chat', () => {
  it('has no computer to run a program on: the call is refused, and nothing is sent', async () => {
    start({ chatId: '0b000000-0000-4000-8000-0000000000c1' })
    expect(await call('callProgram', { name: 'graph' })).toMatchObject({ ok: false, code: 'invalid' })
    expect(sent.calls).toEqual([])
  })
})
