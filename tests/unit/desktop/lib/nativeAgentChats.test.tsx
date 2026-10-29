// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import { useNativeAgentChats } from '../../../../apps/desktop/src/hooks/useNativeAgentChats'
import { installOwnedAgentEntry } from '../../../../apps/desktop/src/lib/ownedAgentConversation'
import { publishDirectoryDevices, updateDeviceSessions, removeDeviceSessions } from '../../../../apps/desktop/src/session/shared/remote-sessions/session-directory'
import type { ChatItem, Device } from '@gugu/core/shared/types/chat'
const harness = createReactHarness()
let remove: (() => void) | undefined
afterEach(() => { harness.cleanup(); remove?.(); removeDeviceSessions('host'); publishDirectoryDevices([]) })
it('keeps the agent and project rows separate, and updates only the agent counter from the host journal', async () => {
  remove = installOwnedAgentEntry({ open: () => true, owns: id => id === 'own-agent' })
  publishDirectoryDevices([{ device_id: 'host', is_online: true, capabilities: {} } as Device])
  const chats = [{ id: 'dm', kind: 'dm', peer_user_id: 'own-agent', unread_count: 2 }, { id: 'project', kind: 'group', unread_count: 8 }] as ChatItem[]
  const session = { conversationId: 'session', agent: { userId: 'own-agent' }, nativeUnreadKeys: ['msg_a', 'msg_b', 'msg_covered'] }
  updateDeviceSessions('host', { cached: false, sessions: [session as never] })
  function Fixture() { return <div>{useNativeAgentChats(chats).map(chat => `${chat.id}:${chat.unread_count}`).join('|')}</div> }
  await harness.render(<Fixture />)
  expect(harness.container.textContent).toBe('dm:5|project:8')
  updateDeviceSessions('host', { cached: false, sessions: [{ ...session, nativeUnreadKeys: ['msg_covered'] } as never] })
  await harness.render(<Fixture />)
  expect(harness.container.textContent).toBe('dm:3|project:8')
})
