// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
const state = vi.hoisted(() => ({
  ready: true, owned: true, renders: vi.fn(), open: vi.fn(), identity: true, chatsRead: true,
}))
vi.mock('../../../../apps/desktop/src/lib/ownedAgentConversation', () => ({
  useOwnedAgentEntries: () => state.ready, isOwnedAgentPeer: () => state.owned, openOwnedAgentEntry: state.open,
}))
vi.mock('../../../../apps/desktop/src/store/chatContext', () => ({ useChatStore: () => ({
  chatsRead: state.chatsRead, chats: [{ id: 'restored-dm', kind: 'dm', peer_user_id: 'agent' }], identitiesById: state.identity ? { agent: { type: 'agent' } } : {},
}) }))
vi.mock('../../../../apps/desktop/src/lib/sidebarChatsBridge', () => ({ useSidebarChatView: () => ({ focusedChatId: null }) }))
vi.mock('../../../../apps/desktop/src/lib/projectGroupChatsBridge', () => ({ useProjectGroupChats: () => new Set() }))
vi.mock('../../../../apps/desktop/src/hooks/useMarkProjectTopicsReadOnOpen', () => ({ useMarkProjectTopicsReadOnOpen: () => undefined }))
vi.mock('../../../../apps/desktop/src/components/assistant/TaskChatScope', () => ({ TaskChatScope: ({ children }: { children: React.ReactNode }) => children }))
vi.mock('../../../../apps/desktop/src/components/ChatAreaPanel', () => ({ ChatAreaPanel: () => { state.renders(); return <div>Legacy IM transcript</div> } }))
import { ChatSlotHost } from '../../../../apps/desktop/src/components/ChatSlotHost'
import { readShellSlots, chatSlotKey } from '../../../../apps/desktop/src/lib/shellSlots'
let harness: ReturnType<typeof createReactHarness>
let slot: HTMLDivElement
beforeEach(() => {
  vi.clearAllMocks(); state.ready = true; state.owned = true; state.identity = true; state.chatsRead = true
  harness = createReactHarness(); slot = document.createElement('div'); document.body.append(slot)
  readShellSlots()!.setSlot(chatSlotKey('restored-dm'), slot)
})
afterEach(() => { harness.cleanup(); readShellSlots()!.setSlot(chatSlotKey('restored-dm'), null); slot.remove() })
it('redirects a restored owned-agent block without mounting its legacy IM component', async () => {
  await harness.render(<ChatSlotHost />)
  expect(state.open).toHaveBeenCalledExactlyOnceWith('restored-dm')
  expect(state.renders).not.toHaveBeenCalled()
  expect(slot.textContent).toBe('')
})
it('waits for ownership before rendering a restored private conversation', async () => {
  state.ready = false; state.owned = false
  await harness.render(<ChatSlotHost />)
  expect(state.renders).not.toHaveBeenCalled()
  state.ready = true; state.owned = true
  await act(async () => { await harness.render(<ChatSlotHost onOpenUserChat={vi.fn()} />) })
  expect(state.open).toHaveBeenCalledWith('restored-dm')
  expect(state.renders).not.toHaveBeenCalled()
})
it('preserves other conversations once their identity is known', async () => {
  state.owned = false
  await harness.render(<ChatSlotHost />)
  expect(state.renders).toHaveBeenCalled()
  expect(slot.textContent).toContain('Legacy IM transcript')
})
it('shows a human DM whose peer remains absent after the initial directory publication', async () => {
  state.owned = false; state.identity = false; state.chatsRead = false
  await harness.render(<ChatSlotHost />)
  expect(state.renders).not.toHaveBeenCalled()
  state.chatsRead = true
  await harness.render(<ChatSlotHost onOpenUserChat={vi.fn()} />)
  expect(state.open).not.toHaveBeenCalled()
  expect(state.renders).toHaveBeenCalled()
  expect(slot.textContent).toContain('Legacy IM transcript')
})
it('still blocks a known owned agent when its directory identity is missing after loading', async () => {
  state.identity = false; state.chatsRead = true
  await harness.render(<ChatSlotHost />)
  expect(state.open).toHaveBeenCalledExactlyOnceWith('restored-dm')
  expect(state.renders).not.toHaveBeenCalled()
})
