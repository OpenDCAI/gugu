// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ContactSearch } from '../../../../apps/desktop/src/components/contacts/ContactSearch'
import { ShareAgentModal } from '../../../../apps/desktop/src/components/contacts/ShareAgentModal'
import { ChannelAgentPicker } from '../../../../apps/desktop/src/components/settings/channels/ChannelAgentPicker'
import { MemberProfileCard } from '../../../../apps/desktop/src/components/MemberProfileCard'
import { ContactsIndex } from '../../../../apps/desktop/src/components/contacts/ContactsIndex'
import { SessionRow } from '../../../../apps/desktop/src/mobile/agent-watch/SessionsPage'
import { installIdentityDirectoryBridge, publishIdentityDirectory } from '../../../../apps/desktop/src/lib/identityDirectoryBridge'
import { clickElement, contact, createNode, createReactHarness, displayIdentity, renderWithAppProviders } from '../../../support/testHarness'

vi.mock('../../../../apps/desktop/src/hooks/useAgentDisplayStatus', () => import('../../../support/agentDisplayStatusTestDouble'))

const createdAt = '2026-11-02T08:00:00.000Z'
const agent = contact({ id: 'fresh-agent', display_name: 'Codex 5', type: 'agent', agent_type: 'codex', owner_user_id: 'user-1', created_at: createdAt })
const providers = { contacts: { contacts: [agent] } }
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(createdAt)
  harness = createReactHarness()
  installIdentityDirectoryBridge()
  publishIdentityDirectory({ [agent.id]: displayIdentity(agent.id, { ...agent, created_at: createdAt }) }, () => {})
})
afterEach(() => { harness.cleanup(); publishIdentityDirectory(null, null); vi.useRealTimers() })

it('keeps the original name in contact search results and the selected contact', async () => {
  const open = vi.fn()
  await renderWithAppProviders(harness, createNode(ContactSearch, {
    query: 'codex5', onQuery: vi.fn(), people: [], agents: [agent], groups: [],
    onOpenContact: open, onOpenGroup: vi.fn(), onLookupNumber: vi.fn(), children: null,
  }), providers)
  const row = harness.container.querySelector<HTMLElement>('[data-contact-id="fresh-agent"]')!
  expect(row.textContent).toContain('Codex 5')
  expect(row.textContent).not.toContain('正在起名…')
  await clickElement(row)
  expect(open).toHaveBeenCalledExactlyOnceWith(agent)
})

it('identifies the real agent name in the sharing dialog', async () => {
  await renderWithAppProviders(harness, createNode(ShareAgentModal, { agent, contacts: [], onClose: vi.fn() }), providers)
  const dialog = document.body.querySelector('[role="dialog"]')!
  expect(dialog.textContent).toContain('Codex 5')
  expect(dialog.textContent).not.toContain('正在起名…')
})

it('keeps settings selector values and options addressed by the real name', async () => {
  const pick = vi.fn()
  await renderWithAppProviders(harness, createNode(ChannelAgentPicker, { agentId: agent.id, onPick: pick, testId: 'agent-picker' }), providers)
  const trigger = harness.container.querySelector<HTMLElement>('[data-testid="agent-picker"]')!
  expect(trigger.textContent).toContain('Codex 5')
  expect(trigger.textContent).not.toContain('正在起名…')
  await clickElement(trigger)
  expect(document.body.querySelector('[data-testid="channel-agent-option-fresh-agent"]')?.textContent).toContain('Codex 5')
})

it.each(['user-1', 'other-owner'])('uses the same placeholder for either viewer, preserving the owner’s rename input (%s)', async ownerUserId => {
  await renderWithAppProviders(harness, createNode(MemberProfileCard, {
    member: { id: agent.id, displayName: agent.display_name, avatar: null, email: null, type: 'agent', ownerUserId, role: 'member', membership: 'current', profileScope: 'group' },
  }), providers)
  expect(harness.container.textContent).toContain('正在起名…')
  expect(harness.container.textContent).not.toContain('Codex 5')
  const rename = harness.container.querySelector<HTMLElement>('[aria-label="重命名"]')
  if (ownerUserId === 'user-1') {
    await clickElement(rename!)
    expect(harness.container.querySelector('input')?.value).toBe('Codex 5')
  } else expect(rename).toBeNull()
})

it('leaves a human with the same default-shaped name unchanged', async () => {
  await renderWithAppProviders(harness, createNode(MemberProfileCard, {
    member: { id: agent.id, displayName: agent.display_name, avatar: null, email: null, type: 'human', role: 'member', membership: 'current', profileScope: 'group' },
  }), providers)
  expect(harness.container.textContent).toContain('Codex 5')
  expect(harness.container.textContent).not.toContain('正在起名…')
})

it.each([false, true])('formats a phone contact for browsing while preserving selection and callback values (select=%s)', async selectionMode => {
  const selected = vi.fn()
  await renderWithAppProviders(harness, createNode(ContactsIndex, {
    title: 'Agents', mobile: true, contacts: [agent], currentUserId: 'user-1', loading: false, selectionMode,
    selectedContactIds: new Set(), onEnterSelectionMode: vi.fn(), onFinishSelectionMode: vi.fn(), onToggleContact: selected,
    onCreateGroupFromSelection: vi.fn(), onSelect: selected, getContactRemoveLabel: () => 'Remove',
  }), providers)
  const row = harness.container.querySelector<HTMLElement>('[data-contact-id="fresh-agent"]')!
  expect(row.textContent).toContain(selectionMode ? 'Codex 5' : '正在起名…')
  await clickElement(row)
  expect(selected).toHaveBeenCalledExactlyOnceWith(agent)
})

it('formats a phone session row using identity creation while opening the raw session', async () => {
  const session = { conversationId: 'task', projectId: 'project', title: 'Codex 5', harness: 'codex', runtime: 'acp', agentStatus: null,
    lastInteractedAt: '2026-11-02T09:00:00.000Z', supported: true, agent: { userId: agent.id } }
  const opened = vi.fn()
  await renderWithAppProviders(harness, createNode(SessionRow, { session, depth: 0, childCount: 0, childrenOpen: false, onToggleChildren: vi.fn(), onOpen: opened }), providers)
  const row = harness.container.querySelector<HTMLElement>('[data-session-id="task"]')!
  expect(row.textContent).toContain('正在起名…')
  await clickElement(row)
  expect(opened).toHaveBeenCalledExactlyOnceWith(session)
  expect(session.title).toBe('Codex 5')
})
