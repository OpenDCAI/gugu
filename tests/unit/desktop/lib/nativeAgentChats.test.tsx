// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import { useNativeAgentChats } from '../../../../apps/desktop/src/hooks/useNativeAgentChats'
import { installOwnedAgentEntry } from '../../../../apps/desktop/src/lib/ownedAgentConversation'
import { publishDirectoryDevices, updateDeviceSessions, removeDeviceSessions } from '../../../../apps/desktop/src/session/shared/remote-sessions/session-directory'
import type { ChatItem, Device } from '@gugu/core/shared/types/chat'
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
