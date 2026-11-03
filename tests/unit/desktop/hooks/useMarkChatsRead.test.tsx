// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness, chat } from '../../../support/testHarness'
import { useMarkChatsRead } from '../../../../apps/desktop/src/hooks/useMarkChatsRead'
import { publishDirectoryDevices, removeDeviceSessions, updateDeviceSessions } from '../../../../apps/desktop/src/session/shared/remote-sessions/session-directory'

const scope = vi.hoisted(() => ({
  chats: [] as ReturnType<typeof chat>[],
  refresh: vi.fn(async () => {}), toast: vi.fn(), rpc: vi.fn(),
  visible: vi.fn(async (_input: { conversationId: string; itemIds: string[] }) => ({ unreadKeys: [] })),
  host: vi.fn(),
}))
vi.mock('../../../../apps/desktop/src/store/chatContext', () => ({ useChatStore: () => ({ chats: scope.chats, refreshChats: scope.refresh }) }))
vi.mock('../../../../apps/desktop/src/components/toastContext', () => ({ useToast: () => ({ toast: scope.toast }) }))
vi.mock('react-i18next', async original => ({ ...await original<object>(), useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: { kind: 'electron' } }))
vi.mock('@/session/renderer/lib/machine-clients', async original => ({ ...await original<object>(), machineClient: (host: string) => {
  scope.host(host)
  return { api: { invoke: (channel: string, input: { conversationId: string; itemIds: string[] }) => {
    if (channel !== 'sessionTimeline.sessionVisible') throw new Error(`Unexpected channel: ${channel}`)
    return scope.visible(input)
  } } }
} }))
vi.mock('../../../../apps/desktop/src/lib/supabase', async original => ({ ...await original<object>(), chatDb: { rpc: scope.rpc } }))

let harness: ReturnType<typeof createReactHarness>
let markRead: ReturnType<typeof useMarkChatsRead>
function Reader() { markRead = useMarkChatsRead(); return null }
beforeEach(async () => {
  await import('@/session/renderer/lib/ipc')
  vi.clearAllMocks()
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
afterEach(() => { harness.cleanup(); removeDeviceSessions('host'); publishDirectoryDevices([]) })

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

it('uses the existing failure toast when the host rejects the native acknowledgement', async () => {
  scope.visible.mockRejectedValueOnce(new Error('host disconnected'))
  await harness.render(<Reader />)
  await act(async () => { markRead('dm') })
  expect(scope.toast).toHaveBeenCalledWith('chatList.markAllReadPartial', 'error', expect.any(String))
})
