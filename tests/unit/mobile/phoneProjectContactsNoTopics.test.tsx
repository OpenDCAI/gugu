// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'
import { createReactHarness } from '../../support/testHarness'

const topic = (id: string): ChatItem => ({
  id, kind: 'topic', status: 'active', name: `topic ${id}`, source_chat_id: 'g', created_at: '2026-10-01T00:00:00Z', last_message_at: null,
  last_message_preview: null, unread_count: 0, pinned_message_id: null, last_read_seq: 0, next_message_seq: 0,
} as ChatItem)

vi.mock('react-i18next', async (importOriginal) => ({ ...await importOriginal<typeof import('react-i18next')>(), useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/components/Avatar', () => ({ Avatar: () => null }))
vi.mock('@/store/auth', () => ({ useAuth: () => ({ user: { id: 'me' } }) }))
vi.mock('@/store/chatContext', () => ({ useChatStore: () => ({ chats: [topic('t1'), topic('t2')] }) }))
vi.mock('@/store/contactsContext', () => ({
  useContactsStore: () => ({
    contacts: [{ id: 'agent-a', display_name: 'Coder', avatar: null, bio: null, type: 'agent', owner_user_id: 'me' }],
    groupChats: [{ id: 'g', member_user_ids: ['me', 'agent-a'] }],
  }),
}))

const { PhoneProjectContacts } = await import('../../../apps/desktop/src/mobile/partners/PhoneProjectContacts')
const { APP_SHOW_SESSION_EVENT } = await import('../../../apps/desktop/src/session/shared/extensions/app-runtime-protocol')

const session = (fields: Partial<SessionpageSessionSummary>): SessionpageSessionSummary =>
  ({ conversationId: 's', projectId: 'p', title: 's', harness: 'claude', runtime: 'acp', agentStatus: null, lastInteractedAt: null, supported: true, ...fields })

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup(); vi.restoreAllMocks() })

// owner 10-28:项目话题在「伙伴」里不该像会话一样成一条(同电脑 #602 侧栏项目下不再列话题);话题在群里顶上的页签里。
describe('phone project contacts', () => {
  const project = { key: 'g', chatId: 'g', name: 'gugu', createdAt: '2026-10-01T00:00:00Z', coverId: 'p', members: [{ deviceId: 'mac', localProjectId: 'p' }] }
  const sessions = [
    { deviceId: 'mac', session: session({ conversationId: 'old', title: 'old work', agent: { userId: 'agent-a' }, lastInteractedAt: '2026-10-01T00:00:00Z' }) },
    { deviceId: 'mac', session: session({ conversationId: 'new', title: 'fix login', agent: { userId: 'agent-a' }, lastInteractedAt: '2026-10-03T00:00:00Z' }) },
  ]

  it('lists the project group once and no topic rows', async () => {
    await harness.render(createElement(PhoneProjectContacts, { project, running: 0, sessions, active: true, onBack: vi.fn(), onOpenGroup: vi.fn() }))
    const text = harness.container.textContent ?? ''
    expect(text).toContain('partners.groupChat')
    expect(text).not.toContain('topic t1')
    expect(text).not.toContain('topic t2')
  })

  it('opens the agent’s latest session in this project when its row is tapped', async () => {
    const onOpenGroup = vi.fn()
    const shown = vi.fn()
    window.addEventListener(APP_SHOW_SESSION_EVENT, shown)
    await harness.render(createElement(PhoneProjectContacts, { project, running: 0, sessions, active: true, onBack: vi.fn(), onOpenGroup }))
    const row = [...harness.container.querySelectorAll('[role="button"]')].find((node) => node.textContent?.includes('Coder')) as HTMLElement
    expect(row.textContent).toContain('fix login')
    await act(async () => { row.click() })
    window.removeEventListener(APP_SHOW_SESSION_EVENT, shown)
    expect(onOpenGroup).not.toHaveBeenCalled()
    expect(shown).toHaveBeenCalledTimes(1)
    const detail = (shown.mock.calls[0]![0] as CustomEvent).detail
    expect(detail.deviceId).toBe('mac')
    expect(detail.session.conversationId).toBe('new')
  })
})
