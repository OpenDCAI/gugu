// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chat, createReactHarness, message, renderWithAppProviders } from '../../../support/testHarness'
import { TaskChatScope } from '../../../../apps/desktop/src/components/assistant/TaskChatScope'
import { useChatStore, type ChatContextValue } from '../../../../apps/desktop/src/store/chatContext'
import { chatWindowStub, topicHistoryStub } from '../../../support/chatWindowStub'
import { upsertMessageById } from '@gugu/core/shared/ui/messageListModels'
import { chatService } from '../../../../apps/desktop/src/lib/chat'
import '../../../../apps/desktop/src/i18n/registerAssistantCatalog'

let harness: ReturnType<typeof createReactHarness>
let task: ChatContextValue
let parent: ChatContextValue
const send = vi.fn(async (_id: string | null, _content: string, _options: unknown) => 'sent-id')
const select = vi.fn()
let windows: ReturnType<typeof chatWindowStub>
function Parent() {
  parent = useChatStore()
  return <><p data-testid="parent">{parent.messages.map((row) => row.content).join(',')}</p><TaskChatScope chatId="task"><Task /></TaskChatScope></>
}
function Task() {
  task = useChatStore()
  return <p data-testid="task">{task.messages.map((row) => `${row.content}:${row.local_send_state ?? row.seq}`).join(',')}</p>
}
beforeEach(() => {
  harness = createReactHarness()
  vi.spyOn(chatService, 'getMessages').mockResolvedValue([message({ id: 'task-1', chat_id: 'task', content: '任务消息' })])
  vi.spyOn(chatService, 'getOtherMembersReadSeqs').mockResolvedValue({})
  vi.spyOn(chatService, 'revalidateWindow').mockImplementation(async (ids) => ({ overlays: new Map(), mutations: new Map(), presentIds: new Set(ids) }))
  send.mockClear(); select.mockClear(); windows = chatWindowStub()
  windows.write('task', () => [message({ id: 'task-1', chat_id: 'task', content: '任务消息' })])
  windows.conversations.actions = (id) => ({ ...topicHistoryStub(id ?? 'empty'),
    sendMessage: (content, options) => send(id, content, options) })
})
afterEach(() => harness.cleanup())
const render = async () => { await renderWithAppProviders(harness, <Parent />, { chat: {
  activeChatId: 'assistant', chats: [chat({ id: 'assistant' }), chat({ id: 'task' })],
  messages: [message({ chat_id: 'assistant', content: '助理消息' })],
  sendMessageToChat: send, setActiveChatId: select, ...windows,
} }); await act(async () => { await vi.dynamicImportSettled() }) }
describe('two visible assistant conversations', () => {
  it('loads and sends on the task line without taking or replacing the assistant line', async () => {
    await render()
    expect(harness.container.querySelector('[data-testid="parent"]')?.textContent).toBe('助理消息')
    expect(harness.container.querySelector('[data-testid="task"]')?.textContent).toContain('任务消息')
    await act(async () => { await task.sendMessage('交给任务') })
    expect(send).toHaveBeenCalledWith('task', '交给任务', undefined)
    expect(parent.activeChatId).toBe('assistant')
    expect(select).not.toHaveBeenCalled()
  })
  it('keeps task outbox failures, confirmations and discard isolated from the assistant', async () => {
    await render()
    const pending = message({ id: 'pending', chat_id: 'task', content: '等待发送', seq: -1, local_send_state: 'sending' })
    act(() => windows.write('task', (rows) => upsertMessageById(rows, pending)))
    expect(harness.container.querySelector('[data-testid="task"]')?.textContent).toContain('等待发送:sending')
    act(() => windows.write('task', (rows) => upsertMessageById(rows, { ...pending, local_send_state: 'failed' })))
    expect(harness.container.querySelector('[data-testid="task"]')?.textContent).toContain('等待发送:failed')
    act(() => windows.write('task', (rows) => rows.filter((row) => row.seq > 0)))
    expect(harness.container.querySelector('[data-testid="task"]')?.textContent).not.toContain('等待发送')
    act(() => windows.write('task', (rows) => upsertMessageById(rows, pending)))
    act(() => windows.write('task', (rows) => upsertMessageById(rows, { ...pending, seq: 2, local_send_state: undefined })))
    expect(harness.container.querySelector('[data-testid="task"]')?.textContent).toContain('等待发送:2')
    act(() => windows.write('task', (rows) => rows.filter((row) => row.seq > 0)))
    expect(harness.container.querySelector('[data-testid="task"]')?.textContent).toContain('等待发送:2')
    expect(harness.container.querySelector('[data-testid="parent"]')?.textContent).toBe('助理消息')
  })
  it('uses the account read failure and retry action without owning another reader', async () => {
    const failure = new Error('read unavailable')
    const retry = vi.fn(async () => {})
    windows.conversations.errorOf = () => failure
    const actions = windows.conversations.actions
    windows.conversations.actions = (id) => ({ ...actions(id), refreshMessages: retry })
    await render()
    expect(task.messagesError).toBe(failure)
    await act(async () => { await task.refreshMessages() })
    expect(retry).toHaveBeenCalledOnce()
    expect(chatService.getMessages).not.toHaveBeenCalled()
    expect(parent.activeChatId).toBe('assistant')
  })
})
