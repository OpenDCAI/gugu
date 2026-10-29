// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import { useNativeConversationChat } from '../../../../apps/desktop/src/hooks/useNativeConversationChat'
import { installOwnedAgentEntry } from '../../../../apps/desktop/src/lib/ownedAgentConversation'
import { publishChatSummaries } from '../../../../apps/desktop/src/lib/chatSummariesBridge'
import { publishDirectoryDevices, removeDeviceSessions, updateDeviceSessions } from '../../../../apps/desktop/src/session/shared/remote-sessions/session-directory'
let harness: ReturnType<typeof createReactHarness>
let release: (() => void) | undefined
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup(); release?.(); release = undefined; publishChatSummaries([]); publishDirectoryDevices([]); removeDeviceSessions('host') })
it('keeps the agent row selected as its workspace updates, and clears it when another page is shown', async () => {
  release = installOwnedAgentEntry({ owns: id => id === 'agent', open: () => true })
  updateDeviceSessions('host', { sessions: [{ conversationId: 'task', agent: { userId: 'agent' } } as never] })
  publishChatSummaries([{ id: 'dm', peer_user_id: 'agent', kind: 'ai', unread_count: 0 }])
  function Fixture({ sessionId }: { sessionId?: string }) { return <span>{useNativeConversationChat(sessionId)}</span> }
  await harness.render(<Fixture sessionId="task" />)
  expect(harness.container.textContent).toBe('dm')
  await act(async () => { publishChatSummaries([{ id: 'dm', peer_user_id: 'agent', kind: 'ai', unread_count: 6, last_message_preview: 'New reply' }]) })
  expect(harness.container.textContent).toBe('dm')
  await harness.render(<Fixture />)
  expect(harness.container.textContent).toBe('')
})
it('does not select a personal DM for a foreign task workspace', async () => {
  release = installOwnedAgentEntry({ owns: () => false, open: () => false })
  updateDeviceSessions('host', { sessions: [{ conversationId: 'task', agent: { userId: 'foreign' } } as never] })
  publishChatSummaries([{ id: 'dm', peer_user_id: 'foreign', kind: 'ai', unread_count: 0 }])
  function Fixture() { return <span>{useNativeConversationChat('task')}</span> }
  await harness.render(<Fixture />)
  expect(harness.container.textContent).toBe('')
})
