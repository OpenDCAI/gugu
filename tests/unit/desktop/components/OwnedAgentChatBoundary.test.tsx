// @vitest-environment jsdom
import { createReactHarness } from '../../../support/testHarness'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ ready: true, owned: true, open: vi.fn(), chat: { kind: 'dm', peerUserId: 'agent' } as { kind: string; peerUserId: string } | undefined }))
vi.mock('@/lib/chatSummariesBridge', () => ({ useChatSummaries: () => new Map(state.chat ? [['dm', state.chat]] : []) }))
vi.mock('@/lib/ownedAgentConversation', () => ({ isOwnedAgentPeer: () => state.owned, openOwnedAgentEntry: state.open, useOwnedAgentEntries: () => state.ready }))
import { OwnedAgentChatBoundary } from '../../../../apps/desktop/src/session/renderer/features/chats/owned-agent-chat-boundary'
let harness: ReturnType<typeof createReactHarness>
afterEach(() => harness.cleanup())
beforeEach(() => { harness = createReactHarness(); state.ready = true; state.owned = true; state.chat = { kind: 'dm', peerUserId: 'agent' }; state.open.mockReset() })
it('redirects an owned-agent restored block before its legacy pane or file slots mount', async () => {
  const legacy = vi.fn(() => <div>legacy pane and slots</div>)
  const Legacy = legacy
  await harness.render(<OwnedAgentChatBoundary chatId="dm"><Legacy /></OwnedAgentChatBoundary>)
  expect(legacy).not.toHaveBeenCalled()
  expect(state.open).toHaveBeenCalledExactlyOnceWith('dm')
})
it('holds a cold private block until ownership is available, while leaving group panes usable', async () => {
  state.ready = false; state.owned = false
  await harness.render(<OwnedAgentChatBoundary chatId="dm">private pane</OwnedAgentChatBoundary>)
  expect(harness.container.textContent?.includes('private pane') ? true : null).toBeNull()
  state.chat = { kind: 'group', peerUserId: '' }
  await harness.render(<OwnedAgentChatBoundary chatId="dm">group pane</OwnedAgentChatBoundary>)
  expect(harness.container.textContent).toBe('group pane')
})
