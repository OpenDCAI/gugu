// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { useLinkNavigation } from '../../../../apps/desktop/src/hooks/useLinkNavigation'
import { openLinkTarget } from '../../../../apps/desktop/src/lib/guguLinks'
import type { GuguLinkTarget } from '@gugu/core/shared/ui/guguLink'
import { until } from '../../../support/awaitCondition'

const mocked = vi.hoisted(() => ({ lookup: vi.fn(), file: vi.fn(), reveal: vi.fn(), task: null as unknown }))
vi.mock('react-i18next', async (original) => ({ ...await original<typeof import('react-i18next')>(), useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../../../../apps/desktop/src/lib/chat', () => ({ chatService: { getMessageById: mocked.lookup } }))
vi.mock('../../../../apps/desktop/src/hooks/useSourceMessageReveal', () => ({ askReveal: mocked.reveal }))
vi.mock('../../../../apps/desktop/src/lib/assistantShellBridge', () => ({ readAssistantShellBridge: () => ({ getSnapshot: () => ({ assistant: { id: 'assistant' }, chatId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }) }) }))
vi.mock('../../../../apps/desktop/src/lib/assistantTaskChat', () => ({ OPEN_ASSISTANT_TASK_CHAT: '__open_assistant_task_chat', readAssistantTaskChat: () => mocked.task }))

vi.mock('../../../../apps/desktop/src/lib/supabase', () => {
  const query = (id = '') => ({ select: () => query(id), eq: (_key: string, value: string) => query(value), maybeSingle: () => mocked.file(id) })
  return { chatDb: { from: () => query() } }
})

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const assistantChat = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const taskChat = 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const messageId = '11111111-2222-4333-8444-555555555555'
const chats = [{ id: assistantChat, peer_user_id: 'assistant' }, { id: taskChat, peer_user_id: 'task' }] as ChatItem[]
const openChat = vi.fn(), openAssistant = vi.fn(), openFile = vi.fn(), openApp = vi.fn(), openOwnApp = vi.fn(), openProject = vi.fn()
let root: Root, container: HTMLDivElement
function Hook({ owner = 'owner' }: { owner?: string }) {
  useLinkNavigation({ ownerId: owner, chats, contacts: [{ id: 'task', type: 'agent', owner_user_id: 'owner' }] as never, openChat, openAssistant, openFile, openApp, openOwnApp, openProject })
  return null
}
function request(target: GuguLinkTarget) {
  const opened = openLinkTarget(target)
  void opened.catch(() => undefined)
  return opened
}
const click = (chatId: string) => request({ kind: 'chat', chatId, messageId })
beforeEach(async () => {
  vi.resetAllMocks()
  openAssistant.mockImplementation((tasks: boolean) => tasks ? 'assistant:task-chat' : 'assistant:chat')
  mocked.task = { assistantId: 'assistant', taskAgentId: 'task', task: { deviceId: 'device', sessionId: 'session' }, assistants: [] }
  mocked.lookup.mockResolvedValue({ chat_id: assistantChat })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => { root.render(<Hook />) })
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })

describe('conversation source navigation', () => {
  it('reveals a valid assistant source on the left without replacing the task pane', async () => {
    await act(async () => { await click(assistantChat) })
    expect(mocked.lookup).toHaveBeenCalledWith(messageId, 'owner')
    expect(mocked.reveal).toHaveBeenCalledWith(assistantChat, messageId, 'assistant:chat')
    expect(openAssistant).toHaveBeenCalledWith(false)
    expect(openChat).not.toHaveBeenCalled()
  })
  it('opens a task in the assistant pane, retaining an exact message target', async () => {
    mocked.lookup.mockResolvedValue({ chat_id: taskChat })
    const listener = vi.fn(); window.addEventListener('__open_assistant_task_chat', listener)
    try {
      await act(async () => { await click(taskChat) })
      expect(openAssistant).toHaveBeenCalledWith(true)
      expect(mocked.reveal).toHaveBeenCalledWith(taskChat, messageId, 'assistant:task-chat')
      expect(listener).toHaveBeenCalledOnce()
      expect(openChat).not.toHaveBeenCalled()
    } finally { window.removeEventListener('__open_assistant_task_chat', listener) }
  })
  it.each([null, { chat_id: taskChat }, { chat_id: assistantChat, retracted_at: 'now' }])('refuses missing, mismatched and retracted messages: %j', async (message) => {
    mocked.lookup.mockResolvedValue(message)
    await act(async () => { await expect(click(assistantChat)).rejects.toThrow('links.unavailable') })
    expect(openAssistant).not.toHaveBeenCalled()
    expect(mocked.reveal).not.toHaveBeenCalled()
  })
  it('keeps a newer task selection ahead of an older message lookup', async () => {
    let finish!: (message: { chat_id: string }) => void
    mocked.lookup.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    let opened!: ReturnType<typeof click>
    await act(async () => { opened = click(assistantChat) })
    await act(async () => window.dispatchEvent(new CustomEvent('__open_assistant_task_chat', { detail: mocked.task })))
    await act(async () => { finish({ chat_id: assistantChat }); await opened })
    expect(openAssistant).toHaveBeenCalledWith(true)
    expect(openAssistant).not.toHaveBeenCalledWith(false)
    expect(mocked.reveal).not.toHaveBeenCalled()
  })

  it('does not navigate or show an old error after changing accounts', async () => {
    let reject!: (error: Error) => void
    mocked.lookup.mockReturnValue(new Promise((_resolve, fail) => { reject = fail }))
    let opened!: ReturnType<typeof click>
    await act(async () => { opened = click(assistantChat) })
    await act(async () => root.render(<Hook owner="another-owner" />))
    await act(async () => { reject(new Error('old request')); await expect(opened).resolves.toBeUndefined() })
    expect(openAssistant).not.toHaveBeenCalled()
  })
})

// The same shell generation orders file lookups and chat lookups; there is no second opener to race it.
describe('file links use the same shell request', () => {
  const a = 'aaaaaaaa-bbbb-4ccc-8ddd-00000000000a', b = 'aaaaaaaa-bbbb-4ccc-8ddd-00000000000b'
  it.each([[a, b], [b, a]])('keeps the latest click when file lookups finish in order %j', async (first, second) => {
    const held = new Map<string, () => void>()
    mocked.file.mockImplementation((id: string) => new Promise((resolve) => held.set(id, () => resolve({ data: { chat_id: assistantChat } }))))
    let openedA!: ReturnType<typeof request>, openedB!: ReturnType<typeof request>
    await act(async () => { openedA = request({ kind: 'file', itemId: a }) })
    await until('first file lookup started', () => held.has(a))
    await act(async () => { openedB = request({ kind: 'file', itemId: b }) })
    await until('second file lookup started', () => held.has(b))
    await act(async () => { held.get(first)!(); await (first === a ? openedA : openedB) })
    await act(async () => { held.get(second)!(); await (second === a ? openedA : openedB) })
    expect(openFile).toHaveBeenCalledOnce()
    expect(openFile).toHaveBeenCalledWith(assistantChat, { kind: 'file', itemId: b }, expect.anything())
  })
  it('preserves the file position, version and caller restore callback', async () => {
    mocked.file.mockResolvedValue({ data: { chat_id: assistantChat } })
    const target = { kind: 'file' as const, itemId: a, version: 7, at: { range: '销售!B2:D4' } }, restore = vi.fn()
    await act(async () => { await openLinkTarget(target, { restore }) })
    expect(openFile).toHaveBeenCalledWith(assistantChat, target, expect.objectContaining({ restore }))
    expect(restore).not.toHaveBeenCalled()
  })
  it('cancels a pending file lookup when a chat is selected next', async () => {
    let finish!: () => void
    mocked.file.mockReturnValue(new Promise((resolve) => { finish = () => resolve({ data: { chat_id: assistantChat } }) }))
    let opened!: ReturnType<typeof request>
    await act(async () => { opened = request({ kind: 'file', itemId: a }) })
    await until('file lookup started', () => mocked.file.mock.calls.length > 0)
    await act(async () => { await click(assistantChat); finish(); await opened })
    expect(openFile).not.toHaveBeenCalled()
    expect(mocked.reveal).toHaveBeenCalledWith(assistantChat, messageId, 'assistant:chat')
  })
})
