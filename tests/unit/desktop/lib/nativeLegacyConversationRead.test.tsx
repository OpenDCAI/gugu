// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import { useNativeConversationRead } from '../../../../apps/desktop/src/hooks/useNativeConversationRead'
import type { ChatView } from '@gugu/session-chat-ui'
const scope = vi.hoisted(() => ({ first: null as string | null, aliases: new Map<string, string[]>() }))
vi.mock('../../../../apps/desktop/src/lib/chatSummariesBridge', () => ({ useChatSummaries: () => new Map([['dm', { peerUserId: 'agent', firstUnreadMessageId: scope.first }]]) }))
vi.mock('../../../../apps/desktop/src/components/chat/agent-dm-record', () => ({ dmRecordIds: () => scope.aliases }))
vi.mock('../../../../apps/desktop/src/session/shared/remote-sessions/session-directory', () => ({ useLiveDeviceSessions: () => ({ host: { sessions: [{ conversationId: 'session', agent: { userId: 'agent' }, nativeUnreadKeys: ['native'] }] } }) }))
const harness = createReactHarness()
afterEach(() => { harness.cleanup(); scope.first = null; scope.aliases = new Map() })
it('places a newly arrived MCP first-unread after a native reply already consumed its own landing', async () => {
  const place = vi.fn()
  let reading!: ReturnType<typeof useNativeConversationRead>
  function Fixture() { reading = useNativeConversationRead('host', 'session', true, () => [{ id: 'turn', seq: 0, initiator: 'user', items: [{ id: 'native', seq: 0, kind: 'message', role: 'assistant', text: 'Native reply' }] }]); return null }
  await harness.render(<Fixture />)
  await act(async () => { reading.onReady({ setScrollMode: place } as unknown as ChatView) })
  expect(place).toHaveBeenLastCalledWith({ kind: 'anchor', itemId: 'native', edge: 'top', offset: -8 })
  scope.first = 'im-first'; scope.aliases = new Map([['tool:sent:im-first', ['im-first']]])
  await harness.render(<Fixture />)
  expect(place).toHaveBeenLastCalledWith({ kind: 'anchor', itemId: 'tool:sent:im-first', edge: 'top', offset: -8 })
  const calls = place.mock.calls.length
  scope.first = 'im-next'; scope.aliases.set('tool:sent:im-next', ['im-next'])
  await harness.render(<Fixture />)
  expect(place).toHaveBeenCalledTimes(calls)
})
