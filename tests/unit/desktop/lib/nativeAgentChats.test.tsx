// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import { useNativeAgentChats } from '../../../../apps/desktop/src/hooks/useNativeAgentChats'
import { installOwnedAgentEntry } from '../../../../apps/desktop/src/lib/ownedAgentConversation'
import { publishDirectoryDevices, updateDeviceSessions, removeDeviceSessions } from '../../../../apps/desktop/src/session/shared/remote-sessions/session-directory'
import type { ChatItem, Device } from '@gugu/core/shared/types/chat'
import { chatPreviewText } from '../../../../apps/desktop/src/lib/agentTurnFailure'
import { act } from 'react'
const shell = vi.hoisted(() => ({ mobile: false }))
vi.mock('@/hooks/useMobileShell', () => ({ useMobileShell: () => shell.mobile }))
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
let remove: (() => void) | undefined
afterEach(() => { harness.cleanup(); remove?.(); removeDeviceSessions('host'); publishDirectoryDevices([]) })
it('keeps the badge on the DM counter: unseen native replies never add to it', async () => {
  remove = installOwnedAgentEntry({ open: () => true, owns: id => id === 'own-agent' })
  publishDirectoryDevices([{ device_id: 'host', is_online: true, capabilities: {} } as Device])
  const chats = [{ id: 'dm', kind: 'dm', peer_user_id: 'own-agent', unread_count: 2 }, { id: 'project', kind: 'group', unread_count: 8 }] as ChatItem[]
  const session = { conversationId: 'session', agent: { userId: 'own-agent' }, nativeUnreadKeys: ['msg_a', 'msg_b', 'msg_covered'] }
  updateDeviceSessions('host', { cached: false, sessions: [session as never] })
  function Fixture() { return <div>{useNativeAgentChats(chats).map(chat => `${chat.id}:${chat.unread_count}`).join('|')}</div> }
  await harness.render(<Fixture />)
  expect(harness.container.textContent).toBe('dm:2|project:8')
})
it('uses newer native activity for the same agent row and keeps newer IM activity authoritative', async () => {
  remove = installOwnedAgentEntry({ open: () => true, owns: id => id === 'own-agent' })
  publishDirectoryDevices([{ device_id: 'host', is_online: true, capabilities: {} } as Device])
  const chats = [{ id: 'dm', kind: 'dm', peer_user_id: 'own-agent', unread_count: 0, last_message_preview: 'Earlier file', last_message_at: '2026-10-29T08:00:00Z' }] as ChatItem[]
  const session = { conversationId: 'session', agent: { userId: 'own-agent' }, nativeLastMessage: { text: 'Native answer', at: '2026-10-29T11:00:00Z' } }
  updateDeviceSessions('host', { cached: false, sessions: [session as never] })
  function Fixture() { const row = useNativeAgentChats(chats)[0]!; return <div>{row.last_message_preview}|{row.last_message_at}</div> }
  await harness.render(<Fixture />)
  expect(harness.container.textContent).toBe('Native answer|2026-10-29T11:00:00Z')
  chats[0] = { ...chats[0]!, last_message_at: '2026-10-29T12:00:00Z', last_message_preview: 'Newer MCP reply' }
  await harness.render(<Fixture />)
  expect(harness.container.textContent).toBe('Newer MCP reply|2026-10-29T12:00:00Z')
})
it.each([false, true])('publishes a new native preview and time without retaining an older IM failure (mobile=%s)', async mobile => {
  shell.mobile = mobile
  remove = installOwnedAgentEntry({ open: () => true, owns: id => id === 'own-agent' })
  publishDirectoryDevices([{ device_id: 'host', is_online: true, capabilities: {} } as Device])
  const chats = [{ id: 'dm', kind: 'dm', peer_user_id: 'own-agent', unread_count: 2, is_marked_unread: true,
    last_message_preview: 'Earlier input', last_message_at: '2026-11-06T04:49:00Z', last_message_failure: 'generic' }] as ChatItem[]
  const session = { conversationId: 'session', agent: { userId: 'own-agent' }, nativeLastMessage: null }
  updateDeviceSessions('host', { cached: false, sessions: [session as never] })
  let projected: ChatItem
  function Fixture() {
    projected = useNativeAgentChats(chats)[0]!
    return <div>{chatPreviewText(projected)}|{projected.last_message_at}</div>
  }
  await harness.render(<Fixture />)
  await act(async () => updateDeviceSessions('host', { sessions: [{ ...session,
    nativeLastMessage: { text: 'New native reply', at: '2026-11-06T05:12:00Z' }, nativeUnreadKeys: ['reply'],
  } as never] }))
  expect(harness.container.textContent).toBe('New native reply|2026-11-06T05:12:00Z')
  expect(projected!.unread_count).toBe(2)
  expect(projected!.is_marked_unread).toBe(true)
  expect(chats[0]!.last_message_failure).toBe('generic')
})
it('on the phone, keeps the agent row listed from the heartbeat summary while its machine is away; on a computer it stays hidden', async () => {
  shell.mobile = true
  remove = installOwnedAgentEntry({ open: () => true, owns: id => id === 'own-agent' })
  const digest = [{ conversationId: 'session', title: 'Task', harness: 'codex', runtime: 'acp', agentStatus: 'idle', lastInteractedAt: '2026-10-31T09:00:00Z', supported: true, nativeInputVersion: 1, agentUserId: 'own-agent' }]
  publishDirectoryDevices([{ device_id: 'host', is_online: false, capabilities: {}, session_digest: digest } as unknown as Device])
  const chats = [{ id: 'dm', kind: 'dm', peer_user_id: 'own-agent', unread_count: 0, last_message_at: null }] as unknown as ChatItem[]
  function Fixture() { return <div>{useNativeAgentChats(chats)[0]!.last_message_at}</div> }
  await harness.render(<Fixture />)
  expect(harness.container.textContent).toBe('2026-10-31T09:00:00Z')
  shell.mobile = false
  await harness.render(<Fixture />)
  expect(harness.container.textContent, 'its session page would wait without a word: the row would do nothing').toBe('')
})

it.each([false, true])("uses the newest actual reply across an agent's tasks (mobile=%s)", async mobile => {
  shell.mobile = mobile
  remove = installOwnedAgentEntry({ open: () => true, owns: id => id === 'own-agent' })
  publishDirectoryDevices([{ device_id: 'host', is_online: true, capabilities: {} } as Device])
  const chats = [{ id: 'dm', kind: 'dm', peer_user_id: 'own-agent', unread_count: 0,
    last_message_at: '2026-11-06T04:49:00Z', last_message_preview: 'Owner input' }] as ChatItem[]
  updateDeviceSessions('host', { cached: false, sessions: [
    { conversationId: 'new-task', agent: { userId: 'own-agent' }, lastInteractedAt: '2026-11-06T05:00:00Z',
      nativeLastMessage: { text: 'First reply', at: '2026-11-06T05:01:00Z' } },
    { conversationId: 'older-task', agent: { userId: 'own-agent' }, lastInteractedAt: '2026-11-06T04:49:00Z',
      nativeLastMessage: { text: 'Last independent reply', at: '2026-11-06T05:12:00Z' } },
  ] as never })
  function Fixture() { const row = useNativeAgentChats(chats)[0]!; return <div>{chatPreviewText(row)}|{row.last_message_at}</div> }
  await harness.render(<Fixture />)
  expect(harness.container.textContent).toBe('Last independent reply|2026-11-06T05:12:00Z')
})
