// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatMessageComposer } from '../../../../apps/desktop/src/components/chat/ChatMessageComposer'
import { SCREEN_CONTENT_DRAG_TYPE, type DraggedScreenContent } from '../../../../apps/desktop/src/session/renderer/lib/drag-screen-content'
import { clickElement, contact, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'
import { readComposer, writeComposer } from '../../../support/composerEditor'
import type { MentionItem } from '@gugu/session-ui/react/components'
import type { GroupChatSettings, GroupCollabSnapshot } from '@gugu/core/shared/types/chat'
import type { ChatMessageComposerProps } from '../../../../apps/desktop/src/components/chat/chatComposerModels'
import { i18n } from '../../../../apps/desktop/src/i18n'

const { resolveSession } = vi.hoisted(() => ({ resolveSession: vi.fn() }))
const service = vi.hoisted(() => ({
  getGroupCollab: vi.fn(), getGroupChatSettings: vi.fn(), inviteGroupMember: vi.fn(), listMyAgentJoinRequests: vi.fn(),
}))
vi.mock('../../../../apps/desktop/src/lib/chat', () => ({ chatService: service }))
vi.mock('../../../../apps/desktop/src/hooks/useAgentDisplayStatus', () => import('../../../support/agentDisplayStatusTestDouble'))
vi.mock('../../../../apps/desktop/src/session/renderer/lib/chat/local-session-mention-provider', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../../apps/desktop/src/session/renderer/lib/chat/local-session-mention-provider')>(),
  createLocalSessionMentionProvider: () => ({ search: async () => [], resolveSession }),
}))
let harness: ReturnType<typeof createReactHarness>
const member = { id: 'member-agent', name: 'Member', type: 'agent' as const }
const outside = contact({ id: 'outside-agent', display_name: 'Task agent', type: 'agent', owner_user_id: 'owner-1' })
const snapshot = (): GroupCollabSnapshot => ({
  scheduler: { chat_id: 'chat', paused: false, queue_count: 0, blocked_count: 0, summary: null, updated_at: '2026-01-01T00:00:00Z' },
  humans: [{ id: 'owner-1', role: 'member', type: 'human', account_status: null }], agents: [], tasks: [], outputs: [],
})
// The viewer's authority is the server projection (group_info_as), not the roster role.
const settings = (over: Partial<GroupChatSettings> = {}) => ({
  id: 'chat', my_role: 'member', can_manage: false, can_dissolve: false, can_archive_topic: false, allow_member_invite: false, ...over,
}) as GroupChatSettings
const mention = (id: string): MentionItem => ({ id: `aid:${id}`, label: `aid:${id}`, name: 'Task agent', kind: 'custom', role: 'agent' })
const input = () => harness.container.querySelector('[data-testid="chat-composer"]')!
const dialog = () => document.querySelector('[role="dialog"]')
const confirmButton = () => [...dialog()!.querySelectorAll<HTMLButtonElement>('button')].find((button) => /^添加/.test(button.textContent ?? ''))!
async function renderGroup(props: Partial<ChatMessageComposerProps> = {}, contacts = [outside], refreshContacts = vi.fn(async () => {})) {
  await renderWithAppProviders(harness, <ChatMessageComposer onSend={vi.fn(async () => {})} chatId="chat" isGroupChat currentUserId="owner-1" groupMembers={[member]} {...props} />, {
    auth: { id: 'owner-1', email: 'owner@example.com', nickname: 'Owner' }, contacts: { contacts, refreshContacts },
  })
}
async function drop(content: DraggedScreenContent = { kind: 'session', projectId: 'p', sessionId: 'task-id', title: 'Private task title' }) {
  const event = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: {
    types: [SCREEN_CONTENT_DRAG_TYPE], getData: () => JSON.stringify(content),
  } })
  await act(async () => { input().dispatchEvent(event) })
}
async function send() {
  await act(async () => { harness.container.querySelector<HTMLButtonElement>('[data-slot="composer-bar"] button[aria-label="发送消息"]')!.click() })
}
beforeEach(() => {
  harness = createReactHarness()
  vi.clearAllMocks()
  resolveSession.mockReset().mockResolvedValue(mention('outside-agent'))
  service.getGroupCollab.mockReset().mockImplementation(async () => ({ snapshot: snapshot(), identities: [] }))
  service.getGroupChatSettings.mockReset().mockResolvedValue(settings())
  service.inviteGroupMember.mockReset().mockResolvedValue({ status: 'joined', chat_id: 'chat' })
  service.listMyAgentJoinRequests.mockReset().mockResolvedValue(new Map())
})
afterEach(() => { harness.cleanup() })

describe('task references in the shared chat composer', () => {
  it('leaves chat and App drops untouched rather than resolving them as task mentions', async () => {
    await renderWithAppProviders(harness, <ChatMessageComposer onSend={vi.fn(async () => {})} chatId="chat" />)
    await act(async () => { writeComposer(input(), 'keep typing') })
    await drop({ kind: 'chat', chatId: 'other-chat', title: 'Other chat' })
    await drop({ kind: 'app', tabKind: 'app-test', title: 'App' })
    expect(resolveSession).not.toHaveBeenCalled()
    expect(readComposer(input())).toBe('keep typing')
  })

  it.each([
    { group: true, id: 'member-agent', recipients: ['member-agent'], annotation: null },
    { group: false, id: 'outside-agent', recipients: [], annotation: null },
  ])('routes group=$group task=$id without changing membership or sharing content', async ({ group, id, recipients, annotation }) => {
    resolveSession.mockResolvedValue(mention(id))
    const onSend = vi.fn(async () => {})
    await renderWithAppProviders(harness, <ChatMessageComposer onSend={onSend} chatId="chat" isGroupChat={group} groupMembers={[member]} />)
    await drop()
    expect(input().querySelector('[data-mention-annotation]')?.textContent ?? null).toBe(annotation)
    expect(input().textContent).not.toContain('Private task title')
    expect(readComposer(input())).toBe(`@[Task agent](aid:${id}) `)
    await send()
    expect(onSend).toHaveBeenCalledWith(`@[Task agent](aid:${id})`, expect.objectContaining({ toUserIds: recipients }))
    expect(service.getGroupCollab).not.toHaveBeenCalled()
    expect(service.inviteGroupMember).not.toHaveBeenCalled()
  })

  it('preselects an outside Agent in the existing member picker without changing the draft, and adds it only after confirmation', async () => {
    await renderGroup()
    await act(async () => { writeComposer(input(), 'keep typing') })
    await drop()
    expect(readComposer(input())).toBe('keep typing')
    expect(input().querySelector('[data-mention-id]')).toBeNull()
    expect(dialog()!.querySelector('button[aria-label="移除 Task agent"]')).not.toBeNull()
    expect(service.inviteGroupMember).not.toHaveBeenCalled()
    expect(confirmButton().disabled).toBe(false) // ordinary members may still add their own Agent
    await clickElement(confirmButton())
    expect(service.inviteGroupMember).toHaveBeenCalledExactlyOnceWith('chat', 'outside-agent')
    expect(dialog()).toBeNull()
    expect(readComposer(input())).toBe('keep typing')
  })

  it('cancels without inserting a mention or requesting membership', async () => {
    await renderGroup()
    await drop()
    await clickElement(dialog()!.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')!)
    expect(dialog()).toBeNull()
    expect(readComposer(input())).toBe('')
    expect(service.inviteGroupMember).not.toHaveBeenCalled()
  })

  it.each([
    { name: 'private Agent owned by someone else', contacts: [{ ...outside, owner_user_id: 'other-owner', agent_public: false }] },
    { name: 'cloud Agent', contacts: [{ ...outside, device_id: 'cloud:device' }] },
    { name: 'missing identity', contacts: [] },
  ])('blocks a preselected $name using the picker eligibility rules', async ({ contacts }) => {
    await renderGroup({}, contacts)
    await drop()
    expect(dialog()!.querySelector('[role="alert"]')?.textContent).toBe(i18n.t('memberPicker.selectionUnavailable', { ns: 'contacts' }))
    expect(confirmButton().disabled).toBe(true)
    await clickElement(confirmButton())
    expect(service.inviteGroupMember).not.toHaveBeenCalled()
    expect(readComposer(input())).toBe('')
  })

  it('waits for refreshed eligibility before enabling confirmation', async () => {
    let finish!: () => void
    const refresh = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    await renderGroup({}, [outside], refresh)
    await drop()
    expect(confirmButton().disabled).toBe(true)
    expect(service.inviteGroupMember).not.toHaveBeenCalled()
    await act(async () => { finish() })
    expect(confirmButton().disabled).toBe(false)
  })

  it('explains that a viewer who left cannot invite, without mutating the group or draft', async () => {
    service.getGroupCollab.mockResolvedValue({ snapshot: { ...snapshot(), humans: [] }, identities: [] })
    service.getGroupChatSettings.mockResolvedValue(settings({ my_role: null }))
    await renderGroup()
    await drop()
    expect(dialog()!.querySelector('[role="alert"]')?.textContent).toBe(i18n.t('group.join.denied.notMember', { ns: 'messaging' }))
    expect(dialog()!.querySelector('button[aria-label="移除 Task agent"]'), 'no picker opens for a non-member').toBeNull()
    expect(service.inviteGroupMember).not.toHaveBeenCalled()
    expect(readComposer(input())).toBe('')
  })

  it('keeps a readable invitation failure visible and permits an explicit retry', async () => {
    service.inviteGroupMember.mockRejectedValueOnce(new Error('actor_not_member'))
    await renderGroup()
    await drop()
    await clickElement(confirmButton())
    expect(dialog()!.querySelector('[role="alert"]')?.textContent).toContain(i18n.t('group.join.denied.notMember', { ns: 'messaging' }))
    expect(readComposer(input())).toBe('')
    await clickElement(confirmButton())
    expect(service.inviteGroupMember).toHaveBeenCalledTimes(2)
    expect(dialog()).toBeNull()
  })

  it.each(['pending_approval', 'pending'])('shows a %s result without creating an addressable mention', async (status) => {
    service.inviteGroupMember.mockResolvedValue({ status, chat_id: 'chat' })
    await renderGroup()
    await drop()
    await clickElement(confirmButton())
    expect(dialog()!.querySelector('[role="status"]')?.textContent).toContain(i18n.t(status === 'pending' ? 'group.picker.invitationSent' : 'group.picker.pendingApproval', { ns: 'messaging', count: 1 }))
    expect(readComposer(input())).toBe('')
    expect(service.inviteGroupMember).toHaveBeenCalledTimes(1)
  })

  it('finishes resolving after an edit, but never inserts into a different chat', async () => {
    let finish!: (item: MentionItem) => void
    resolveSession.mockImplementation(() => new Promise<MentionItem>((resolve) => { finish = resolve }))
    const render = (chatId: string) => renderWithAppProviders(harness, <ChatMessageComposer onSend={vi.fn(async () => {})} chatId={chatId} isGroupChat groupMembers={[member]} />)
    await render('a')
    await drop()
    await act(async () => { writeComposer(input(), 'keep typing ') })
    await act(async () => { finish(mention('member-agent')) })
    expect(readComposer(input())).toBe('keep typing @[Task agent](aid:member-agent) ')
    await drop()
    await render('b')
    await act(async () => { finish(mention('outside-agent')) })
    expect(readComposer(input())).toBe('')
    expect(dialog()).toBeNull()
    expect(service.getGroupCollab).not.toHaveBeenCalled()
  })

  it('does not open a late outside-Agent invitation after its composer is hidden', async () => {
    let finish!: (item: MentionItem) => void
    resolveSession.mockImplementation(() => new Promise<MentionItem>((resolve) => { finish = resolve }))
    await renderGroup()
    await drop()
    await renderGroup({ hidden: true })
    await act(async () => { finish(mention('outside-agent')) })
    expect(dialog()).toBeNull()
    expect(service.getGroupCollab).not.toHaveBeenCalled()
    expect(readComposer(input())).toBe('')
  })

  it('restores a saved task pill and keeps handwritten references addressable', async () => {
    const onSend = vi.fn(async () => {})
    const text = '@[Saved task](aid:member-agent) check this\r\n@[Private](aid:outside-agent)'
    await renderWithAppProviders(harness, <ChatMessageComposer onSend={onSend} chatId="saved" isGroupChat groupMembers={[member]} />,
      { chat: { drafts: { saved: text } } })
    expect(input().querySelector('[data-mention-id="aid:member-agent"]')).not.toBeNull()
    expect(readComposer(input())).toBe(text.replace(/\r\n/g, '\n'))
    await act(async () => { writeComposer(input(), '@[Handwritten](aid:member-agent) please reply') })
    await send()
    expect(onSend).toHaveBeenCalledWith('@[Handwritten](aid:member-agent) please reply', expect.objectContaining({ toUserIds: ['member-agent'] }))
  })
})
