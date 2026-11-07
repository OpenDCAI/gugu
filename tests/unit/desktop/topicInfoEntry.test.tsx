// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { GroupCollabSnapshot } from '@gugu/core/shared/types/chat'
import type { ChatContextValue } from '../../../apps/desktop/src/store/chatContext'
import { openImRepository, readGroupRoster, replaceGroupRoster, type AccountImRepository } from '../../../apps/desktop/src/lib/imRepository'
import { createMemoryLocalSyncDb } from '../../../apps/desktop/src/lib/localSyncDb'
import { chat, createNode, createReactHarness, displayIdentity, renderWithAppProviders } from '../../support/testHarness'

const shell = vi.hoisted(() => ({ mobile: false }))
vi.mock('../../../apps/desktop/src/hooks/useMobileShell', () => ({ useMobileShell: () => shell.mobile }))
vi.mock('../../../apps/desktop/src/lib/chat', () => ({
  chatService: { getGroupCollab: vi.fn(), getGroupChatSettings: vi.fn(), listGroupJoinRequests: vi.fn(async () => []) },
  GroupCollabEmptyError: class extends Error {},
}))

const { chatService, GroupCollabEmptyError } = await import('../../../apps/desktop/src/lib/chat')
const { ChatSettingsPanel } = await import('../../../apps/desktop/src/components/chat/ChatSettingsPanel')
const { NATIVE_BACK_EVENT } = await import('../../../apps/desktop/src/components/ui/sheetStack')
const getCollab = vi.mocked(chatService.getGroupCollab)
const getSettings = vi.mocked(chatService.getGroupChatSettings)
const snapshot: GroupCollabSnapshot = {
  scheduler: { chat_id: 'topic-1', paused: false, queue_count: 0, blocked_count: 0, summary: null, updated_at: new Date(0).toISOString() },
  humans: [{ id: 'viewer', role: 'member', type: 'human', account_status: null }], agents: [], tasks: [],
}
let harness: ReturnType<typeof createReactHarness>
let repository: AccountImRepository
beforeEach(async () => {
  harness = createReactHarness()
  repository = await openImRepository('viewer', { adapter: createMemoryLocalSyncDb() })
  getCollab.mockResolvedValue({ snapshot, identities: [displayIdentity('viewer', { display_name: 'Viewer' })] })
})
afterEach(() => { harness.cleanup(); repository.close(); vi.clearAllMocks(); vi.useRealTimers() })

async function renderTopic(mobile: boolean, manageable: boolean, subscribeAccountRevision: ChatContextValue['subscribeAccountRevision'] = () => () => {}) {
  shell.mobile = mobile
  getSettings.mockResolvedValue({ id: 'topic-1', name: 'Current topic', my_role: 'member', can_manage: manageable } as never)
  const onClose = vi.fn()
  await renderWithAppProviders(harness, createNode(ChatSettingsPanel, {
    activeChat: chat({ id: 'source', kind: 'group', name: 'Source group' }),
    topic: { topicChatId: 'topic-1', name: 'Current topic' }, mobile,
    messages: [], onClose, onClearMessages: vi.fn(), onOpenSearch: vi.fn(),
    onSetNotificationLevel: vi.fn(), onTogglePinned: vi.fn(), memberProfiles: [], currentUserId: 'viewer',
    groupCollabSnapshot: snapshot, groupAgentStatuses: {}, onReloadGroupCollab: vi.fn(),
    onLeaveGroup: vi.fn(), onDissolveGroup: vi.fn(),
  }), {
    auth: { id: 'viewer' }, contacts: { contacts: [] },
    chat: { chats: [chat({ id: 'topic-1', kind: 'topic', name: 'Stale personal summary' })],
      identitiesById: { viewer: displayIdentity('viewer', { display_name: 'Viewer' }) },
      getImRepository: async () => repository, subscribeAccountRevision },
  })
  return onClose
}

it.each([[false, false], [false, true], [true, false], [true, true]])('topic info reuses the topic roster and server authority (mobile=%s, manageable=%s)', async (mobile, manageable) => {
  const close = await renderTopic(mobile, manageable)
  expect(getCollab).toHaveBeenCalledWith('topic-1')
  expect(getCollab).not.toHaveBeenCalledWith('source')
  expect(getSettings).toHaveBeenCalledWith('topic-1')
  expect(harness.container.querySelector('[data-testid="member-list-panel"]')?.getAttribute('data-chat-kind')).toBe('topic')
  expect(harness.container.querySelector('[data-testid="topic-name-edit"]')?.textContent).toContain('Current topic')
  expect(harness.container.querySelector('[data-testid="group-name-edit"]') !== null).toBe(manageable)
  expect(harness.container.querySelector('[data-testid="member-list-invite"]')).toBeNull()
  if (mobile) {
    await act(async () => { window.dispatchEvent(new Event(NATIVE_BACK_EVENT)) })
    expect(close).toHaveBeenCalledOnce()
  }
})

it('removes stale participant rows after the viewer leaves the topic', async () => {
  let changed: Parameters<ChatContextValue['subscribeAccountRevision']>[1] | undefined
  await renderTopic(false, false, (event, listener) => {
    if (event === 'chat_members_changed') changed = listener
    return () => {}
  })
  expect(harness.container.querySelector('[data-member-row="viewer"]')).not.toBeNull()
  getCollab.mockRejectedValue(new GroupCollabEmptyError())
  vi.useFakeTimers()
  await act(async () => {
    changed?.([{ revision: '2', event: 'chat_members_changed', payload: { chat_id: 'topic-1', user_id: 'viewer', kind: 'roster', tombstone: true } }])
    await vi.advanceTimersByTimeAsync(300)
  })
  expect(harness.container.querySelector('[data-member-list-error="not-participant"]')).not.toBeNull()
  expect(harness.container.querySelector('[data-member-row="viewer"]')).toBeNull()
})

it('does not publish the local topic roster before current participation is confirmed', async () => {
  await replaceGroupRoster(repository, 'topic-1', snapshot, [displayIdentity('viewer', { display_name: 'Viewer' })])
  expect(readGroupRoster(repository, 'topic-1')?.humans).toHaveLength(1)
  let rejectRead!: (error: Error) => void
  getCollab.mockReturnValue(new Promise((_resolve, reject) => { rejectRead = reject }))
  await renderTopic(false, false)
  try {
    expect(harness.container.querySelector('[data-member-row="viewer"]')).toBeNull()
  } finally {
    await act(async () => { rejectRead(new GroupCollabEmptyError()) })
  }
  expect(harness.container.querySelector('[data-member-list-error="not-participant"]')).not.toBeNull()
  expect(harness.container.querySelector('[data-member-row="viewer"]')).toBeNull()
})

it('refreshes topic authority on source-group revocation and ignores private read-position events', async () => {
  let changed: Parameters<ChatContextValue['subscribeAccountRevision']>[1] | undefined
  await renderTopic(false, true, (event, listener) => {
    if (event === 'chat_members_changed') changed = listener
    return () => {}
  })
  const before = getCollab.mock.calls.length
  vi.useFakeTimers()
  await act(async () => {
    changed?.([{ revision: '2', event: 'chat_members_changed', payload: { chat_id: 'topic-1', user_id: 'viewer', kind: 'own', tombstone: false } }])
    await vi.advanceTimersByTimeAsync(300)
  })
  expect(getCollab).toHaveBeenCalledTimes(before)
  getSettings.mockResolvedValue({ id: 'topic-1', name: 'Current topic', my_role: 'member', can_manage: false } as never)
  await act(async () => {
    changed?.([{ revision: '3', event: 'chat_members_changed', payload: { chat_id: 'source', user_id: 'viewer', kind: 'roster', tombstone: false } }])
    await vi.advanceTimersByTimeAsync(300)
  })
  expect(getSettings).toHaveBeenLastCalledWith('topic-1')
  expect(harness.container.querySelector('[data-testid="group-name-edit"]')).toBeNull()
})
