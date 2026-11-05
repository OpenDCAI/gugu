// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness, chat } from '../../../support/testHarness'
import { useMarkChatsRead } from '../../../../apps/desktop/src/hooks/useMarkChatsRead'
import { publishDirectoryDevices, removeDeviceSessions, updateDeviceSessions } from '../../../../apps/desktop/src/session/shared/remote-sessions/session-directory'
import { SESSION_HOST_BRIDGE_KEY } from '../../../../apps/desktop/src/session/renderer/lib/electron-api'

const scope = vi.hoisted(() => ({
  chats: [] as ReturnType<typeof chat>[],
  refresh: vi.fn(async () => {}), toast: vi.fn(), rpc: vi.fn(),
  visible: vi.fn(async (_input: { conversationId: string; itemIds: string[] }) => ({ unreadKeys: [] })),
  host: vi.fn(), local: vi.fn(async (_channel: string, _input: unknown) => ({ unreadKeys: [] })),
  kind: 'electron',
}))
vi.mock('../../../../apps/desktop/src/store/chatContext', () => ({ useChatStore: () => ({ chats: scope.chats, refreshChats: scope.refresh }) }))
vi.mock('../../../../apps/desktop/src/components/toastContext', () => ({ useToast: () => ({ toast: scope.toast }) }))
vi.mock('react-i18next', async original => ({ ...await original<object>(), useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/platform', () => ({ platform: { get kind() { return scope.kind } } }))
vi.mock('@/mobile/agent-watch/sessionpage-rpc', async () => ({ machineRpc: (device: string) => {
  scope.host(device)
  return { sessionTimeline: { sessionVisible: scope.visible } }
} }))
vi.mock('@/session/renderer/lib/machine-clients', () => ({ reportMachineOutdated: vi.fn(), machineClient: (host: string) => {
  scope.host(host)
  return { api: { invoke: (channel: string, input: { conversationId: string; itemIds: string[] }) => {
    if (channel !== 'sessionTimeline.sessionVisible') throw new Error(`Unexpected channel: ${channel}`)
    return scope.visible(input)
  } } }
} }))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ chatDb: { rpc: scope.rpc } }))
vi.mock('../../../../apps/desktop/src/store/chatRealtimeMutations', () => ({ persistManualUnread: vi.fn() }))

let harness: ReturnType<typeof createReactHarness>
let markRead: ReturnType<typeof useMarkChatsRead>
function Reader() { markRead = useMarkChatsRead(); return null }
beforeEach(async () => {
  await import('@/session/renderer/lib/ipc')
  await import('@/mobile/agent-watch/sessionpage-rpc')
  vi.clearAllMocks()
  scope.visible.mockReset().mockResolvedValue({ unreadKeys: [] })
  scope.kind = 'electron'
  harness = createReactHarness()
  scope.chats = [chat({ id: 'dm', kind: 'ai', peer_user_id: 'mine' }), chat({ id: 'other', kind: 'ai', peer_user_id: 'other' })]
  scope.rpc.mockResolvedValue({ data: [], error: null })
  publishDirectoryDevices([{ device_id: 'host', is_online: true } as never])
  updateDeviceSessions('host', { cached: false, sessions: [
    { conversationId: 'mine', nativeUnreadKeys: ['one'], agent: { userId: 'mine' } },
    { conversationId: 'other', nativeUnreadKeys: ['two'], agent: { userId: 'other' } },
    { conversationId: 'native-only', nativeUnreadKeys: ['three'] },
  ] as never })
})
afterEach(() => {
  harness.cleanup(); removeDeviceSessions('host'); removeDeviceSessions('remote-host'); publishDirectoryDevices([])
  delete (window as unknown as Record<string, unknown>)[SESSION_HOST_BRIDGE_KEY]
})

it('connects the explicit global action to the account directory even without cloud locators', async () => {
  await harness.render(<Reader />)
  await act(async () => { markRead() })
  expect(scope.visible.mock.calls.map(([input]) => input.conversationId)).toEqual(['mine', 'other', 'native-only'])
  expect(scope.host.mock.calls).toEqual([['host'], ['host'], ['host']])
  expect(scope.refresh).toHaveBeenCalledExactlyOnceWith({ acceptEmpty: true })
})

it('keeps a selected DM action inside that peer and leaves group/topic scopes on their existing cloud path', async () => {
  await harness.render(<Reader />)
  await act(async () => { markRead('dm') })
  expect(scope.visible).toHaveBeenCalledExactlyOnceWith({ conversationId: 'mine', itemIds: ['one'] })
  scope.visible.mockClear()
  scope.chats = [chat({ id: 'group', kind: 'group' }), chat({ id: 'topic', kind: 'topic', source_chat_id: 'group' })]
  await harness.render(<Reader />)
  await act(async () => { markRead('group') })
  expect(scope.visible).not.toHaveBeenCalled()
})

it('does not read a stale directory entry from devices outside the current account list', async () => {
  publishDirectoryDevices([])
  await harness.render(<Reader />)
  await act(async () => { markRead() })
  expect(scope.visible).not.toHaveBeenCalled()
})

it('writes the current desktop journal over IPC while preserving the exact remote device route', async () => {
  const hostWindow = window as unknown as Record<string, unknown>
  hostWindow[SESSION_HOST_BRIDGE_KEY] = { invoke: scope.local }
  publishDirectoryDevices([{ device_id: 'host', is_online: true, is_current_device: true }, { device_id: 'remote-host', is_online: true }] as never)
  updateDeviceSessions('host', { cached: false, sessions: [{ conversationId: 'local', nativeUnreadKeys: ['local-reply'] } as never] })
  updateDeviceSessions('remote-host', { cached: false, sessions: [{ conversationId: 'remote', nativeUnreadKeys: ['remote-reply'] } as never] })
  await harness.render(<Reader />)
  await act(async () => { markRead() })
  expect(scope.local).toHaveBeenCalledExactlyOnceWith('sessionTimeline.sessionVisible', { conversationId: 'local', itemIds: ['local-reply'] })
  expect(scope.host.mock.calls).toEqual([['remote-host']])
  expect(scope.visible).toHaveBeenCalledExactlyOnceWith({ conversationId: 'remote', itemIds: ['remote-reply'] })
})

it('uses the existing failure toast when the host rejects the native acknowledgement', async () => {
  scope.visible.mockRejectedValueOnce(new Error('host disconnected'))
  await harness.render(<Reader />)
  await act(async () => { markRead('dm') })
  expect(scope.toast).toHaveBeenCalledWith('chatList.markAllReadPartial', 'error', expect.any(String))
})

it('captures cloud and native identities in the click stack before either projection can advance', async () => {
  scope.chats[0].next_message_seq = 10
  scope.rpc.mockImplementation(async (name: string, args?: { p_stream_id: string }) => name === 'list_unread_locators'
    ? { data: [{ chat_id: 'dm', message_seq: 3 }], error: null }
    : { data: [{ stream_id: args?.p_stream_id }], error: null })
  await harness.render(<Reader />)
  await act(async () => {
    markRead('dm')
    scope.chats[0].next_message_seq = 11
    updateDeviceSessions('host', { sessions: [{ conversationId: 'mine', nativeUnreadKeys: ['one', 'later'], agent: { userId: 'mine' } }] as never })
  })
  expect(scope.rpc).toHaveBeenCalledWith('mark_stream_read', { p_chat_id: 'dm', p_stream_id: 'main:dm', p_seq: 9, p_thread_root_id: null })
  expect(scope.visible).toHaveBeenCalledExactlyOnceWith({ conversationId: 'mine', itemIds: ['one'] })
})

it('uses the existing phone machine route, even when that device is marked current', async () => {
  scope.kind = 'capacitor'
  publishDirectoryDevices([{ device_id: 'host', is_online: true, is_current_device: true }] as never)
  await harness.render(<Reader />)
  // Separate actions isolate this transport check from Vitest's concurrent dynamic-import mock race.
  // The multi-selection and batching cases above/below still exercise concurrent native writes.
  await act(async () => { markRead('dm') })
  await vi.waitFor(() => expect(scope.refresh).toHaveBeenCalledTimes(1))
  await act(async () => { markRead('other') })
  await vi.waitFor(() => expect(scope.refresh).toHaveBeenCalledTimes(2))
  expect({ host: scope.host.mock.calls, visible: scope.visible.mock.calls, local: scope.local.mock.calls, toast: scope.toast.mock.calls }).toEqual({
    host: [['host'], ['host']], visible: [[{ conversationId: 'mine', itemIds: ['one'] }], [{ conversationId: 'other', itemIds: ['two'] }]], local: [], toast: [],
  })
})

it('keeps a multi-selection inside the selected peers, excluding unbound native tasks', async () => {
  await harness.render(<Reader />)
  await act(async () => { markRead(['dm', 'other']) })
  expect(scope.visible.mock.calls.map(([input]) => input.conversationId)).toEqual(['mine', 'other'])
})
