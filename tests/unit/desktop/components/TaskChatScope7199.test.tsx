// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chat, createReactHarness, message, renderWithAppProviders } from '../../../support/testHarness'
import { TaskChatScope } from '../../../../apps/desktop/src/components/assistant/TaskChatScope'
import { useChatStore, type ChatContextValue } from '../../../../apps/desktop/src/store/chatContext'
import { chatWindowStub } from '../../../support/chatWindowStub'
import { upsertMessageById } from '@gugu/core/shared/ui/messageListModels'
import { chatService } from '../../../../apps/desktop/src/lib/chat'
import '../../../../apps/desktop/src/i18n/registerAssistantCatalog'

let harness: ReturnType<typeof createReactHarness>
let task: ChatContextValue
let parent: ChatContextValue
const send = vi.fn(async () => 'sent-id')
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
    act(() => windows.messageWindows.write('task', (rows) => upsertMessageById(rows, pending)))
    expect(harness.container.querySelector('[data-testid="task"]')?.textContent).toContain('等待发送:sending')
    act(() => windows.messageWindows.write('task', (rows) => upsertMessageById(rows, { ...pending, local_send_state: 'failed' })))
    expect(harness.container.querySelector('[data-testid="task"]')?.textContent).toContain('等待发送:failed')
    act(() => windows.messageWindows.write('task', (rows) => rows.filter((row) => row.seq > 0)))
    expect(harness.container.querySelector('[data-testid="task"]')?.textContent).not.toContain('等待发送')
    act(() => windows.messageWindows.write('task', (rows) => upsertMessageById(rows, pending)))
    act(() => windows.messageWindows.write('task', (rows) => upsertMessageById(rows, { ...pending, seq: 2, local_send_state: undefined })))
    expect(harness.container.querySelector('[data-testid="task"]')?.textContent).toContain('等待发送:2')
    act(() => windows.messageWindows.write('task', (rows) => rows.filter((row) => row.seq > 0)))
    expect(harness.container.querySelector('[data-testid="task"]')?.textContent).toContain('等待发送:2')
    expect(harness.container.querySelector('[data-testid="parent"]')?.textContent).toBe('助理消息')
  })
  it('hands a task read failure to the message list and retries without erasing the assistant conversation', async () => {
    vi.mocked(chatService.getMessages).mockRejectedValueOnce(new Error('read unavailable'))
    await render()
    // #7199 读失败交给消息列表去说(读不到 + 重试),❌ 这里另起一行、底下仍是首次对话欢迎页。
    expect(task.messagesError?.message).toBe('read unavailable')
    expect(task.messages).toEqual([])
    expect(parent.messagesError).toBeNull()
    await act(async () => { await task.refreshMessages() })
    expect(task.messagesError).toBeNull()
    expect(task.messages[0]?.content).toBe('任务消息')
    expect(parent.activeChatId).toBe('assistant')
  })
  it('an older retry that fails after a newer retry succeeded does not bring the read failure back', async () => {
    vi.mocked(chatService.getMessages).mockRejectedValueOnce(new Error('read unavailable'))
    await render()
    expect(task.messagesError?.message).toBe('read unavailable')
    let failOlder!: (error: Error) => void
    vi.mocked(chatService.getMessages).mockImplementationOnce(() => new Promise((_ok, fail) => { failOlder = fail }))
    let older!: Promise<void>
    await act(async () => { older = task.refreshMessages() })
    await act(async () => { await task.refreshMessages() })
    expect(task.messagesError).toBeNull()
    expect(task.messages[0]?.content).toBe('任务消息')
    await act(async () => { failOlder(new Error('older retry failed late')); await older })
    expect(task.messagesError).toBeNull()
    expect(task.messages[0]?.content).toBe('任务消息')
  })
})
