// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import { useNativeConversationRead } from '../../../../apps/desktop/src/hooks/useNativeConversationRead'
import { updateDeviceSessions, removeDeviceSessions } from '../../../../apps/desktop/src/session/shared/remote-sessions/session-directory'
import { addNativeReplies, seeNativeReplies, unreadNativeMessages, unreadOwnerNotifications, type NativeReadJournal } from '@gugu/session-core/session-record/native-read'
// @ts-expect-error — injection-tested ESM MCP implementation.
import { callTool } from '../../../../apps/desktop/electron/mcp/gugu-im-server.mjs'

const scope = vi.hoisted(() => ({
  active: true, focused: true, kind: 'electron' as 'electron' | 'capacitor',
  listener: null as null | ((active: boolean) => void),
  visible: vi.fn<(input: { conversationId: string; itemIds: string[] }) => Promise<{ unreadKeys: string[] }>>(),
  snapshot: vi.fn<(input: { conversationId: string }) => Promise<{ unreadKeys: string[]; ownerNotificationUnreadKeys?: string[] }>>(),
  ipcRoute: vi.fn(), mobileRoute: vi.fn(),
}))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: {
  get kind() { return scope.kind },
  subscribeAppActive: (listener: (active: boolean) => void) => {
    scope.listener = listener; listener(scope.active); return () => { scope.listener = null }
  },
} }))
vi.mock('../../../../apps/desktop/src/session/renderer/lib/ipc', () => ({ rpcOn: (device: string | null) => {
  scope.ipcRoute(device); return { sessionTimeline: { sessionVisible: scope.visible, sessionReadState: scope.snapshot } }
} }))
vi.mock('../../../../apps/desktop/src/mobile/agent-watch/sessionpage-rpc', () => ({ machineRpc: (device: string) => {
  scope.mobileRoute(device); return { sessionTimeline: { sessionVisible: scope.visible, sessionReadState: scope.snapshot } }
} }))
let harness: ReturnType<typeof createReactHarness>
let journal: NativeReadJournal
const owner = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const agent = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const dm = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'

function publish() {
  updateDeviceSessions('host', { sessions: [{ conversationId: 'session', nativeInputVersion: 2,
    nativeUnreadKeys: unreadNativeMessages(journal),
    nativeOwnerNotificationUnreadCount: unreadOwnerNotifications(journal).length } as never] })
}
function Reader({ shown = true, sessionId = 'session', deviceId = 'host' }: { shown?: boolean; sessionId?: string; deviceId?: string }) {
  // No ChatView, visible-item callback, loaded history, or scroll-to-tail is supplied.
  useNativeConversationRead(deviceId, sessionId, shown, () => [])
  return null
}
function addNotice(id: string) { journal = addNativeReplies(journal, [id], new Map(), new Set([id])) }

beforeEach(() => {
  vi.useFakeTimers()
  harness = createReactHarness()
  journal = addNativeReplies({}, ['ordinary-unseen'])
  scope.active = true; scope.focused = true; scope.kind = 'electron'
  vi.spyOn(document, 'hasFocus').mockImplementation(() => scope.focused)
  scope.snapshot.mockImplementation(async () => ({ unreadKeys: unreadNativeMessages(journal), ownerNotificationUnreadKeys: unreadOwnerNotifications(journal) }))
  scope.visible.mockImplementation(async input => {
    expect(input.conversationId).toBe('session')
    journal = seeNativeReplies(journal, input.itemIds)
    return { unreadKeys: unreadNativeMessages(journal) }
  })
})
afterEach(() => {
  harness.cleanup(); removeDeviceSessions('host')
  vi.useRealTimers(); vi.restoreAllMocks()
  scope.visible.mockReset(); scope.snapshot.mockReset(); scope.ipcRoute.mockClear(); scope.mobileRoute.mockClear()
})

it.each([
  ['message_send', `user:${owner}`], ['message_send', dm], ['message_send', '218799'],
  ['message_send_file', `user:${owner}`], ['message_send_file', dm], ['message_send_file', '218799'],
])('reads %s to %s on opening without reaching its message', async (tool, destination) => {
  const token = `x.${Buffer.from(JSON.stringify({ sub: owner })).toString('base64url')}.x`
  const runHostAction = vi.fn(async (input: { request_id: string }) => {
    addNotice(`session:turn:s3:message:${input.request_id}`)
    return { status: 'sent', message_id: input.request_id, session_id: 'session', seq: 3 }
  })
  const context = { agentId: agent, threadRootId: null, getAccessToken: async () => token, runHostAction }
  const deps = {
    restGet: vi.fn(async (path: string) => path.startsWith('chats?') ? [{ id: dm, public_id: 218799 }] : []),
    restRpc: vi.fn(async (name: string) => name === 'chat_facts' ? [{ kind: 'dm', rules: null }]
      : name === 'list_member_ids' ? [{ user_id: owner }, { user_id: agent }] : null),
    restInsert: vi.fn(),
  }
  await callTool(context, tool, { chat_id: destination, ...(tool === 'message_send' ? { text: 'Review' } : { file_path: '/work/report.html' }) }, deps)
  expect(runHostAction).toHaveBeenCalledOnce()
  expect(unreadOwnerNotifications(journal)).toHaveLength(1)
  publish()
  await harness.render(<Reader />)
  expect(unreadOwnerNotifications(journal)).toEqual([])
  expect(unreadNativeMessages(journal)).toEqual(['ordinary-unseen'])
  expect(deps.restInsert).not.toHaveBeenCalled()
})

it.each(['electron', 'capacitor'] as const)('uses the same durable identities on %s without reading another conversation', async kind => {
  scope.kind = kind
  addNotice('notice-a'); addNotice('notice-b'); publish()
  await harness.render(<Reader sessionId="other-session" />)
  expect(scope.visible).not.toHaveBeenCalled()
  await harness.render(<Reader />)
  expect(scope.visible).toHaveBeenCalledExactlyOnceWith({ conversationId: 'session', itemIds: ['notice-a', 'notice-b'] })
  expect(unreadOwnerNotifications(journal)).toEqual([])
  expect((kind === 'electron' ? scope.ipcRoute : scope.mobileRoute)).toHaveBeenCalledWith('host')
})

it('requires a shown page, foreground host and this window focus', async () => {
  addNotice('notice'); publish()
  scope.active = false
  await harness.render(<Reader shown={false} />)
  await harness.render(<Reader />)
  expect(scope.visible).not.toHaveBeenCalled()
  scope.focused = false
  await act(async () => { scope.active = true; scope.listener?.(true) })
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(scope.visible).not.toHaveBeenCalled()
  scope.focused = true
  await act(async () => { window.dispatchEvent(new Event('focus')) })
  expect(unreadOwnerNotifications(journal)).toEqual([])
})

it('does not include later notifications in this opening, even after a refocus', async () => {
  addNotice('opening-notice'); publish()
  await harness.render(<Reader />)
  addNotice('later-notice')
  await act(async () => { publish(); window.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(1000) })
  expect(unreadOwnerNotifications(journal)).toEqual(['later-notice'])
  expect(scope.visible).toHaveBeenCalledTimes(1)
  await harness.render(<Reader shown={false} />)
  await harness.render(<Reader />)
  expect(unreadOwnerNotifications(journal)).toEqual([])
})

it('does not pretend a failed write succeeded and retries the same captured identities', async () => {
  addNotice('notice'); publish()
  scope.visible.mockRejectedValueOnce(new Error('host unavailable'))
  await harness.render(<Reader />)
  expect(unreadOwnerNotifications(journal)).toEqual(['notice'])
  await act(async () => { await vi.advanceTimersByTimeAsync(500) })
  expect(scope.visible).toHaveBeenCalledTimes(2)
  expect(unreadOwnerNotifications(journal)).toEqual([])
})

it('does not clear an older host that has no owner-only read snapshot', async () => {
  addNotice('notice'); publish()
  scope.snapshot.mockResolvedValueOnce({ unreadKeys: ['notice'] })
  await harness.render(<Reader />)
  expect(scope.visible).not.toHaveBeenCalled()
  expect(unreadOwnerNotifications(journal)).toEqual(['notice'])
  await harness.render(<Reader shown={false} />)
  await harness.render(<Reader />)
  expect(unreadOwnerNotifications(journal)).toEqual([])
})

it('reads a fresh host snapshot even when the cached list count is zero', async () => {
  publish()
  addNotice('already-on-host')
  await harness.render(<Reader />)
  expect(scope.snapshot).toHaveBeenCalledExactlyOnceWith({ conversationId: 'session' })
  expect(unreadOwnerNotifications(journal)).toEqual([])
})

it('does not acknowledge after focus is lost while the host snapshot is in flight', async () => {
  addNotice('notice'); publish()
  let resolve!: (snapshot: { unreadKeys: string[]; ownerNotificationUnreadKeys: string[] }) => void
  scope.snapshot.mockImplementationOnce(() => new Promise(done => { resolve = done }))
  await harness.render(<Reader />)
  scope.focused = false
  await act(async () => resolve({ unreadKeys: ['notice'], ownerNotificationUnreadKeys: ['notice'] }))
  expect(scope.visible).not.toHaveBeenCalled()
  expect(unreadOwnerNotifications(journal)).toEqual(['notice'])
  scope.focused = true
  await act(async () => { window.dispatchEvent(new Event('focus')) })
  expect(unreadOwnerNotifications(journal)).toEqual([])
})

it('keeps one snapshot when the app blurs and refocuses while that snapshot is loading', async () => {
  addNotice('notice'); publish()
  let resolve!: (snapshot: { unreadKeys: string[]; ownerNotificationUnreadKeys: string[] }) => void
  scope.snapshot.mockImplementationOnce(() => new Promise(done => { resolve = done }))
  await harness.render(<Reader />)
  await act(async () => { scope.active = false; scope.listener?.(false) })
  addNotice('later-notice')
  await act(async () => { scope.active = true; scope.listener?.(true) })
  await act(async () => resolve({ unreadKeys: ['notice'], ownerNotificationUnreadKeys: ['notice'] }))
  expect(scope.snapshot).toHaveBeenCalledTimes(1)
  expect(unreadOwnerNotifications(journal)).toEqual(['later-notice'])
})

it('does not acknowledge while the document is hidden even if the host and focus reports are stale', async () => {
  addNotice('notice'); publish()
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  await harness.render(<Reader />)
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(scope.snapshot).not.toHaveBeenCalled()
  expect(scope.visible).not.toHaveBeenCalled()
})

it('batches over 500 identities without swallowing a notification arriving during the read', async () => {
  for (let i = 0; i < 501; i++) addNotice(`notice-${i}`)
  publish()
  await harness.render(<Reader />)
  expect(scope.visible.mock.calls[0]![0].itemIds).toHaveLength(500)
  addNotice('later-notice')
  await act(async () => { publish(); await vi.advanceTimersByTimeAsync(500) })
  expect(scope.visible.mock.calls[1]![0].itemIds).toEqual(['notice-500'])
  expect(unreadOwnerNotifications(journal)).toEqual(['later-notice'])
})
