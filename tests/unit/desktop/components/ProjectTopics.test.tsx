// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatListSlotHost, ProjectTopics } from '../../../../apps/desktop/src/components/ChatListSlotHost'
import { ChatListPanel } from '../../../../apps/desktop/src/components/ChatListPanel'
import { installAssistantShellBridge, publishAssistantShell, type AssistantShellSnapshot } from '../../../../apps/desktop/src/lib/assistantShellBridge'
import { drainTopicSplitRequest } from '../../../../apps/desktop/src/lib/topicSplitRequest'
import { publishSidebarChatSignals, sidebarChatSignals, useSidebarChatSignals } from '../../../../apps/desktop/src/lib/sidebarChatsBridge'
import { installSessionViewRequestBridge } from '../../../../apps/desktop/src/session/renderer/features/sessions/stores/session-view-requests'
import { chat, clickElement, createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'

vi.mock('../../../../apps/desktop/src/platform', () => import('../../../support/capacitorPlatformTestDouble'))

let harness: ReturnType<typeof createReactHarness>
const openChat = vi.fn()
beforeEach(() => {
  harness = createReactHarness()
  openChat.mockReset()
  installSessionViewRequestBridge(window, { openChat })
})
afterEach(() => harness.cleanup())

const source = chat({ id: 'group', kind: 'group', name: 'Planning' })
const topics = Array.from({ length: 5 }, (_, index) => chat({
  id: `topic-${index}`, kind: 'topic', source_chat_id: source.id, name: `Review ${index}`,
  last_message_at: `2099-01-0${5 - index}T00:00:00Z`, unread_count: index === 4 ? 8 : 0,
}))
const rows = () => Array.from(harness.container.querySelectorAll<HTMLElement>('[data-topic-subrow]'))

describe('shared sidebar topic branches', () => {
  it.each(['project', 'group'] as const)('%s reveals read topics inline and opens the existing source/split path', async (kind) => {
    const node = kind === 'project'
      ? createNode(ProjectTopics, { sourceChatId: source.id })
      : createNode(ChatListPanel, { placement: 'sidebar' })
    const markMessageVisible = vi.fn()
    const render = (unread: number) => renderWithAppProviders(harness, node, {
      chat: { chats: [source, ...topics.map((topic) => ({ ...topic, unread_count: topic.id === 'topic-4' ? unread : 0 }))], markMessageVisible },
      contacts: {},
    })
    await render(8)
    expect(rows().map((row) => row.dataset.topicSubrow)).toEqual(['topic-0', 'topic-1', 'topic-2', 'topic-4'])
    expect(rows().at(-1)?.textContent).toContain('8')
    await clickElement(harness.container.querySelector('[data-testid="topic-sunk-section"]') as HTMLElement)
    expect(rows().map((row) => row.dataset.topicSubrow)).toEqual(topics.map((topic) => topic.id))
    expect(harness.container.querySelector('[data-testid="history-panel"]')).toBeNull()
    expect(openChat).not.toHaveBeenCalled()
    expect(markMessageVisible).not.toHaveBeenCalled()
    await clickElement(rows().at(-1)!)
    expect(openChat).toHaveBeenCalledWith(source.id, false)
    expect(drainTopicSplitRequest(source.id)).toMatchObject({ chatId: 'topic-4', sourceChatId: source.id })
    await render(0)
    expect(rows()).toHaveLength(5)
    expect(rows().at(-1)?.textContent).not.toContain('8')
  })

  it('publishes mainline unread changes even when the project aggregate is unchanged', async () => {
    const projectGroups = new Set([source.id])
    function Badge() {
      const signals = useSidebarChatSignals()
      return <span>{signals?.groupMainUnread.get(source.id) ?? 0}/{signals?.groupUnread.get(source.id) ?? 0}</span>
    }
    await harness.render(createNode(Badge))
    await act(async () => publishSidebarChatSignals(sidebarChatSignals([source, ...topics], projectGroups)))
    expect(harness.container.textContent).toBe('0/8')
    await act(async () => publishSidebarChatSignals(sidebarChatSignals([
      { ...source, unread_count: 3 }, { ...topics[4], unread_count: 5 },
    ], projectGroups)))
    expect(harness.container.textContent).toBe('3/8')
  })
})


it('updates the badge when the assistant is identified while the conversation list is unmounted', async () => {
  installAssistantShellBridge(window)
  const snapshot = { assistantState: 'loading', assistant: null, chatId: null } as AssistantShellSnapshot
  publishAssistantShell(snapshot)
  const chats = [chat({ id: 'assistant-dm', kind: 'dm', peer_user_id: 'mine', unread_count: 1 }), chat({ id: 'ordinary', unread_count: 2 })]
  function Probe() {
    const signals = useSidebarChatSignals()
    return <><ChatListSlotHost /><span data-testid="published-unread">{signals?.chatsUnread}</span></>
  }
  await renderWithAppProviders(harness, createNode(Probe), { chat: { chats } })
  expect(harness.container.querySelector('[data-testid="published-unread"]')?.textContent).toBe('3')
  await act(async () => publishAssistantShell({ ...snapshot, assistantState: 'found', assistant: { id: 'mine', display_name: 'Assistant', avatar: null, created_at: null }, chatId: 'assistant-dm' }))
  expect(harness.container.querySelector('[data-testid="published-unread"]')?.textContent).toBe('2')
  expect(chats[0]?.unread_count).toBe(1)
})
