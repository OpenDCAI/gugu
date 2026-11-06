// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import '@renderer/lib/stores/app-state'
import { ChatListPanel } from '../../../apps/desktop/src/components/ChatListPanel'
import { chatService } from '../../../apps/desktop/src/lib/chat'
import { chat, clickElement, createNode, createReactHarness, renderWithAppProviders } from '../../support/testHarness'

vi.mock('../../../apps/desktop/src/platform', () => import('../../support/capacitorPlatformTestDouble'))
vi.mock('../../../apps/desktop/src/hooks/useAgentDisplayStatus', () => import('../../support/agentDisplayStatusTestDouble'))
vi.mock('../../../apps/desktop/src/store/devicesContext', () => ({ useDevicesStore: () => ({ devices: [] }) }))
vi.mock('@renderer/lib/ipc', () => ({ events: { on: vi.fn() }, rpc: {}, onMachineEvent: () => () => undefined }))

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { vi.useRealTimers(); harness.cleanup(); vi.restoreAllMocks() })

it('phone group long-press invokes the shared personal hide action as an ordinary member and preserves the open chat and draft', async () => {
  const settings = vi.spyOn(chatService, 'getGroupChatSettings').mockRejectedValue(new Error('administration read denied'))
  const hide = vi.fn().mockResolvedValue(undefined), legacy = vi.fn(), select = vi.fn(), leave = vi.fn()
  const row = chat({ id: 'personal-group', kind: 'group', name: 'Phone group', unread_count: 2, my_role: 'member' })
  const store = { chats: [row], hideConversation: hide, deleteChat: legacy, leaveGroup: leave, setActiveChatId: select,
    activeChatId: row.id, activeChat: row, drafts: { [row.id]: 'keep my draft' } }
  await renderWithAppProviders(harness, createNode(ChatListPanel, { mobile: true }), { chat: store, contacts: {} })
  const target = harness.container.querySelector<HTMLElement>('[data-chat-row=personal-group]')!
  expect(target).not.toBeNull()
  vi.useFakeTimers()
  await act(async () => {
    const down = new Event('pointerdown', { bubbles: true })
    Object.assign(down, { pointerType: 'touch', clientX: 20, clientY: 80, pointerId: 1 })
    target.dispatchEvent(down)
    vi.advanceTimersByTime(500)
  })
  vi.useRealTimers()
  const action = document.querySelector<HTMLElement>('[data-testid=conversation-row-delete-chat]')
  expect(action).not.toBeNull()
  expect(action?.textContent).toContain('从列表删除')
  await clickElement(action!)
  expect(hide).toHaveBeenCalledExactlyOnceWith(row.id)
  expect(settings).not.toHaveBeenCalled()
  expect(legacy).not.toHaveBeenCalled()
  expect(leave).not.toHaveBeenCalled()
  expect(select).not.toHaveBeenCalled()
  expect(store.drafts[row.id]).toBe('keep my draft')
  expect(store.activeChatId).toBe(row.id)
})
