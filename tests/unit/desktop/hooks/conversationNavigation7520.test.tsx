// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { useConversationLinkNavigation } from '../../../../apps/desktop/src/hooks/useConversationLinkNavigation'
import { openConversationLink } from '../../../../apps/desktop/src/lib/conversationLinks'

const mocked = vi.hoisted(() => ({ toast: vi.fn(), lookup: vi.fn(), reveal: vi.fn(), task: null as unknown }))
vi.mock('../../../../apps/desktop/src/components/toastContext', () => ({ useToast: () => ({ toast: mocked.toast }) }))
vi.mock('react-i18next', async (original) => ({ ...await original<typeof import('react-i18next')>(), useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../../../../apps/desktop/src/lib/chat', () => ({ chatService: { getMessageById: mocked.lookup } }))
vi.mock('../../../../apps/desktop/src/hooks/useSourceMessageReveal', () => ({ askReveal: mocked.reveal }))
vi.mock('../../../../apps/desktop/src/lib/assistantShellBridge', () => ({ readAssistantShellBridge: () => ({ getSnapshot: () => ({ assistant: { id: 'assistant' }, chatId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }) }) }))
vi.mock('../../../../apps/desktop/src/lib/assistantTaskChat', () => ({ OPEN_ASSISTANT_TASK_CHAT: '__open_assistant_task_chat', readAssistantTaskChat: () => mocked.task }))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const assistantChat = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const taskChat = 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const messageId = '11111111-2222-4333-8444-555555555555'
const chats = [{ id: assistantChat, peer_user_id: 'assistant' }, { id: taskChat, peer_user_id: 'task' }] as ChatItem[]
const openChat = vi.fn(), openAssistant = vi.fn()
let root: Root, container: HTMLDivElement
function Hook({ owner = 'owner' }: { owner?: string }) {
  useConversationLinkNavigation({ ownerId: owner, chats, contacts: [{ id: 'task', type: 'agent', owner_user_id: 'owner' }] as never, openChat, openAssistant })
  return null
}
async function click(chat: string) { await act(async () => { openConversationLink(`gugu-chat://${chat}/${messageId}`) }) }
beforeEach(async () => {
  vi.clearAllMocks()
  openAssistant.mockImplementation((tasks: boolean) => tasks ? 'assistant:task-chat' : 'assistant:chat')
  mocked.task = { assistantId: 'assistant', taskAgentId: 'task', task: { deviceId: 'device', sessionId: 'session' }, assistants: [] }
  mocked.lookup.mockResolvedValue({ chat_id: assistantChat })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => { root.render(<Hook />) })
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })

describe('conversation source navigation', () => {
  it('reveals a valid assistant source on the left without replacing the task pane', async () => {
    await click(assistantChat)
    expect(mocked.lookup).toHaveBeenCalledWith(messageId, 'owner')
    expect(mocked.reveal).toHaveBeenCalledWith(assistantChat, messageId, 'assistant:chat')
    expect(openAssistant).toHaveBeenCalledWith(false)
    expect(openChat).not.toHaveBeenCalled()
  })
  it('opens a task in the assistant pane, retaining an exact message target', async () => {
    mocked.lookup.mockResolvedValue({ chat_id: taskChat })
    const listener = vi.fn(); window.addEventListener('__open_assistant_task_chat', listener)
    try {
      await click(taskChat)
      expect(openAssistant).toHaveBeenCalledWith(true)
      expect(mocked.reveal).toHaveBeenCalledWith(taskChat, messageId, 'assistant:task-chat')
      expect(listener).toHaveBeenCalledOnce()
      expect(openChat).not.toHaveBeenCalled()
    } finally { window.removeEventListener('__open_assistant_task_chat', listener) }
  })
  it.each([null, { chat_id: taskChat }, { chat_id: assistantChat, retracted_at: 'now' }])('refuses missing, mismatched and retracted messages: %j', async (message) => {
    mocked.lookup.mockResolvedValue(message)
    await click(assistantChat)
    expect(openAssistant).not.toHaveBeenCalled()
    expect(mocked.reveal).not.toHaveBeenCalled()
    expect(mocked.toast).toHaveBeenCalledWith('links.unavailable', 'error')
  })
  it('keeps a newer task selection ahead of an older message lookup', async () => {
    let finish!: (message: { chat_id: string }) => void
    mocked.lookup.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    await click(assistantChat)
    await act(async () => window.dispatchEvent(new CustomEvent('__open_assistant_task_chat', { detail: mocked.task })))
    await act(async () => finish({ chat_id: assistantChat }))
    expect(openAssistant).toHaveBeenCalledWith(true)
    expect(openAssistant).not.toHaveBeenCalledWith(false)
    expect(mocked.reveal).not.toHaveBeenCalled()
  })

  it('does not navigate or show an old error after changing accounts', async () => {
    let reject!: (error: Error) => void
    mocked.lookup.mockReturnValue(new Promise((_resolve, fail) => { reject = fail }))
    await click(assistantChat)
    await act(async () => root.render(<Hook owner="another-owner" />))
    await act(async () => reject(new Error('old request')))
    expect(openAssistant).not.toHaveBeenCalled()
    expect(mocked.toast).not.toHaveBeenCalled()
  })
})
