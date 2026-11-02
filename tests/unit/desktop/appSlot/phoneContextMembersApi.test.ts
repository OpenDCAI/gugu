// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hostAppFrame } from '../../../../apps/desktop/src/components/appSlot/phoneAppHost'
import { APP_FRAME_MARKER } from '../../../../apps/desktop/src/session/shared/extensions/app-runtime-protocol'
import { until } from '../../../support/awaitCondition'

const fixture = vi.hoisted(() => ({ apiVersion: 26, routes: [] as string[] }))
const CHAT = '0b000000-0000-4000-8000-000000000021'
const PERSON = '0a000000-0000-4000-8000-000000000021'
const ORIGIN = 'https://folder.acct.apps.gugu.invalid'
vi.mock('../../../../apps/desktop/src/lib/sessionPublication', () => ({ getRendererAccessToken: () => 'h.eyJzdWIiOiJwZXJzb24tMSJ9.s' }))
vi.mock('../../../../apps/desktop/src/lib/identityReadAdapter', () => ({ readDisplayIdentities: async () => [{ id: PERSON, name: 'Reader', kind: 'human' }] }))
vi.mock('../../../../apps/desktop/src/lib/memberFaces', () => ({ memberFaces: async () => ({}) }))
vi.mock('../../../../apps/desktop/src/session/renderer/features/extensions/installed-extensions-store', () => ({
  installedExtensionsStore: { manifests: [], icons: {}, isEnabled: () => true,
    manifestFor: () => ({ id: 'folder', name: 'Folder', version: '1.0.0', apiVersion: fixture.apiVersion, contributes: { tabs: [] } }),
  },
}))
vi.mock('@gugu/core/cloud/supabase', () => ({ createGuguSupabaseClient: () => ({
  rpc: async (name: string, args: { p_chat_id: string }) => {
    fixture.routes.push(`rpc/${name}`)
    return { data: name === 'chat_facts' ? [{ id: args.p_chat_id, kind: 'group', source_chat_id: null }] : [{ user_id: PERSON }], error: null }
  },
  from: (table: string) => {
    const query = { select: () => query, eq: () => query,
      maybeSingle: async () => { fixture.routes.push(table); return { data: { id: CHAT, kind: 'group', name: 'Group', source_chat_id: null }, error: null } },
    }
    return query
  },
}) }))

let frame: HTMLIFrameElement
let posted: ReturnType<typeof vi.fn>
let host: ReturnType<typeof hostAppFrame> | undefined
let nextId = 0
const contextEvents = () => posted.mock.calls.filter(([message]) => message.t === 'event' && message.event?.type === 'context')
async function call(method: string, args: Record<string, unknown> = {}) {
  const id = ++nextId
  window.dispatchEvent(new MessageEvent('message', { data: { m: APP_FRAME_MARKER, t: 'call', id, method, args }, source: frame.contentWindow, origin: ORIGIN }))
  await until(`the phone answered ${method}`, () => posted.mock.calls.some(([message]) => message.id === id))
  return posted.mock.calls.find(([message]) => message.id === id)![0]
}
beforeEach(() => {
  fixture.routes.length = 0
  frame = document.createElement('iframe')
  frame.src = `${ORIGIN}/index.html`
  document.body.appendChild(frame)
  posted = vi.fn()
  Object.defineProperty(frame.contentWindow!, 'postMessage', { value: posted, configurable: true })
})
function start(apiVersion: number) {
  fixture.apiVersion = apiVersion
  host = hostAppFrame(frame, { extensionId: 'folder', tabId: 'folder', tabName: 'main', chatId: CHAT,
    capabilities: ['chat:read'], locale: 'en', themeMode: 'light' }, { showMessage: vi.fn(), showSession: () => ({ shown: true }), openWith: vi.fn(), chrome: vi.fn() })
}
afterEach(() => { host?.dispose(); host = undefined; frame.remove() })

describe('chat members in the phone App context', () => {
  it('API 25 receives members in the first answer', async () => {
    start(25)
    expect(await call('getContext')).toMatchObject({ ok: true, value: { chat: { members: [{ id: `user:${PERSON}` }] } } })
    expect(fixture.routes).toContain('rpc/list_member_ids')
  })

  it('API 26 omits members, supports the explicit call and does not push on roster changes', async () => {
    start(26)
    const first = await call('getContext')
    expect(first.ok).toBe(true)
    expect(first.value.chat).not.toHaveProperty('members')
    expect(fixture.routes).not.toContain('rpc/list_member_ids')
    const pushed = contextEvents().length
    host!.membersChanged([{ memberId: PERSON, left: true }])
    await call('getContext')
    expect(contextEvents()).toHaveLength(pushed)
    expect(fixture.routes).not.toContain('rpc/list_member_ids')
    expect(await call('chatsMembers', { chat: CHAT })).toMatchObject({ ok: true, value: { members: [{ id: `user:${PERSON}` }] } })
  })
})
