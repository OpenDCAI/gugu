// @vitest-environment jsdom
// #5661 通讯录里的外部 Agent 只来自共同 active group。群和成员 id 来自会话投影,身份就是投影带回来的那份
// (投影只把身份已到的成员放进 member_user_ids),❌ 另拉一张群表、另读一遍身份。
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNode, createReactHarness } from '../../../support/testHarness'
import type { ContactUser } from '@gugu/core/shared/types/contacts'
import type { DisplayIdentity } from '../../../../apps/desktop/src/lib/displayIdentity'

const { authUser, contactsServiceMock, identitiesById, getImRepositoryMock, refreshChatsMock, chatState, identityListeners, pendingNames, revisionConsumers } = vi.hoisted(() => {
  const identitiesById = {} as Record<string, ContactUser>
  const identityListeners = new Set<() => void>()
  return {
    authUser: { id: 'user-1', email: 'user@example.test', nickname: 'User One' },
    identitiesById,
    identityListeners,
    pendingNames: [] as Array<{ conversationId: string; agentUserId: string; displayName: string; pendingManual?: true }>,
    revisionConsumers: new Map<string, () => Promise<void>>(),
    getImRepositoryMock: vi.fn(),
    contactsServiceMock: {
      getContacts: vi.fn(),
      getContactGroups: vi.fn(),
      getReceivedRequests: vi.fn(),
      getSentRequests: vi.fn(),
      updateContactAlias: vi.fn(),
      removeOwnedAgent: vi.fn(),
      updateOwnedAgentProfile: vi.fn(),
      uploadOwnedAgentAvatar: vi.fn(),
      setAgentPublic: vi.fn(),
      setAgentDesiredStatus: vi.fn(),
      searchUsers: vi.fn(),
    },
    refreshChatsMock: vi.fn(),
    chatState: { chats: [] as unknown[] },
  }
})

vi.mock('../../../../apps/desktop/src/store/auth', () => ({ useAuth: () => ({ user: authUser, loading: false }) }))
vi.mock('../../../../apps/desktop/src/store/chatContext', () => ({
  useChatStore: () => ({
    refreshChats: refreshChatsMock,
    chats: chatState.chats,
    loadingChats: false,
    chatsLoadFailed: false,
    deleteChat: vi.fn(),
    patchChat: vi.fn(),
    identitiesById,
    getImRepository: getImRepositoryMock,
    subscribeAccountRevision: (kind: string, run: () => Promise<void>) => { revisionConsumers.set(kind, run); return () => { revisionConsumers.delete(kind) } },
  }),
}))
vi.mock('../../../../apps/desktop/src/lib/contacts', () => ({ contactsService: contactsServiceMock }))

vi.mock('../../../../apps/desktop/src/session/renderer/lib/shell-port', () => ({
  findSessionShellPort: () => desktopPort,
  onSessionpageIdentityEvent: () => () => {},
  isSessionShellUnsupported: () => false,
}))

const { renameLocal, renameTask } = vi.hoisted(() => ({ renameLocal: vi.fn(), renameTask: vi.fn() }))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: { renameOwnedAgentLocalFootprint: renameLocal } }))
const { assistant, reportAssistant } = vi.hoisted(() => ({ assistant: { id: null as string | null }, reportAssistant: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/myAssistant', () => ({ isMyAssistant: (ownerId: string, id: string) => ownerId === authUser.id && id === assistant.id }))
vi.mock('../../../../apps/desktop/src/components/assistant/assistant-app-client', () => ({ reportAssistantAppChange: reportAssistant }))

import { ContactsProvider } from '../../../../apps/desktop/src/store/contacts'
import { desktopIdentityEntries } from '../../../support/desktopIdentityEntries'
import { createSessionShellPort } from '../../../../apps/desktop/src/session/shared/lib/ipc/shell-port'
import { SessionAgentNames } from '../../../../apps/desktop/src/session/renderer/features/sessions/stores/session-agent-names'
import { UI_EVENTS } from '../../../../apps/desktop/src/lib/uiEvents'
import { installIdentityDirectoryBridge, publishIdentityDirectory, readIdentityDirectoryBridge, type IdentityDirectorySnapshot } from '../../../../apps/desktop/src/lib/identityDirectoryBridge'
import { readPerfCounters } from '../../../../apps/desktop/src/lib/perfCounters'
import { useContactsStore, type ContactsContextValue } from '../../../../apps/desktop/src/store/contactsContext'
import { imSelectors, openImRepository, type AccountImRepository } from '../../../../apps/desktop/src/lib/imRepository'
import { createMemoryLocalSyncDb } from '../../../../apps/desktop/src/lib/localSyncDb'

// Contacts uses the actual registered desktop callback and the real parser, not an invoke shortcut.
const desktopPort = createSessionShellPort(desktopIdentityEntries({
  sessionpageIdentityHost: { agentNames: async () => pendingNames },
  identityHost: { renameAgent: renameTask },
  authProvider: { getAuth: async () => ({ userId: authUser.id, accessToken: 'token' }) },
  loadEmdashBridge: () => ({}),
}).invoke)

let store: ContactsContextValue | null = null
let repository: AccountImRepository
function Capture() {
  store = useContactsStore()
  return null
}

async function flushReact(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

async function renderProvider() {
  repository = await openImRepository(authUser.id, { adapter: createMemoryLocalSyncDb(), initialize: async () => {} })
  await repository.putIdentities(Object.values(identitiesById))
  repository.subscribe(imSelectors.identitiesById, (rows) => {
    for (const id of Object.keys(identitiesById)) delete identitiesById[id]
    Object.assign(identitiesById, rows)
    for (const notify of identityListeners) notify()
  })
  getImRepositoryMock.mockResolvedValue(repository)
  const harness = createReactHarness()
  await harness.render(createNode(ContactsProvider, null, createNode(Capture)))
  await flushReact()
  return harness
}

function holdNamesResponse() {
  const actual = desktopPort.agentNames.bind(desktopPort)
  let release!: () => void
  let reject!: (error: Error) => void
  let captured: Awaited<ReturnType<typeof actual>> | undefined
  const read = vi.spyOn(desktopPort, 'agentNames').mockImplementationOnce(async () => {
    captured = await actual()
    await new Promise<void>((resolve, fail) => { release = resolve; reject = fail })
    return captured
  })
  return { captured: () => captured, wait: () => vi.waitFor(() => expect(release).toBeTypeOf('function')),
    release: () => release?.(), reject: (error: Error) => reject(error), restore: () => read.mockRestore() }
}

function observeRenameListeners() {
  const active = new Set<EventListenerOrEventListenerObject>()
  const add = window.addEventListener.bind(window)
  const remove = window.removeEventListener.bind(window)
  const adding = vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
    add(type, listener, options)
    if (type === UI_EVENTS.ownedAgentRenamed && listener) active.add(listener)
  })
  const removing = vi.spyOn(window, 'removeEventListener').mockImplementation((type, listener, options) => {
    remove(type, listener, options)
    if (type === UI_EVENTS.ownedAgentRenamed && listener) active.delete(listener)
  })
  return {
    count: () => active.size,
    restore: () => {
      for (const listener of active) remove(UI_EVENTS.ownedAgentRenamed, listener)
      active.clear()
      adding.mockRestore()
      removing.mockRestore()
    },
  }
}

function pendingAgent() {
  const agent = { ...sharedGroupAgent, owner_user_id: authUser.id, display_name: 'Earlier local' }
  identitiesById[agent.id] = agent
  pendingNames.push({ conversationId: 'task', agentUserId: agent.id, displayName: agent.display_name, pendingManual: true })
  return agent
}

async function beginUpdate(operation: () => Promise<void>) {
  let pending!: Promise<void>
  await act(async () => { pending = operation() })
  return { pending }
}

const sharedGroupAgent: DisplayIdentity = {
  id: 'shared-agent',
  display_name: 'Shared Agent',
  avatar: null,
  bio: null,
  type: 'agent',
  owner_user_id: 'other-owner',
  gugu_number: null, agent_public: null, desired_status: null, device_id: null,
  category: null, is_official: null, local_path: null, created_at: null, updated_at: null,
}
const sharedGroupRow = {
  id: 'group-1', kind: 'group' as const, status: 'active' as const, name: 'Small group', created_at: '2026-10-01T00:00:00Z',
  last_message_at: null, last_message_preview: null, unread_count: 0, pinned_message_id: null, last_read_seq: 0, next_message_seq: 1,
  member_user_ids: ['user-1', 'other-owner', sharedGroupAgent.id],
}

beforeEach(() => {
  assistant.id = null
  reportAssistant.mockReset().mockResolvedValue(undefined)
  renameLocal.mockReset().mockResolvedValue(undefined)
  store = null
  identityListeners.clear()
  pendingNames.length = 0
  renameTask.mockReset().mockImplementation(async ({ sessionId, name }: { sessionId: string; name: string }) => {
    const row = pendingNames.find((entry) => entry.conversationId === sessionId)!
    row.displayName = name.trim()
    row.pendingManual = true
    window.dispatchEvent(new CustomEvent(UI_EVENTS.ownedAgentRenamed, { detail: { agentUserId: row.agentUserId, displayName: row.displayName } }))
    return { ...row }
  })
  revisionConsumers.clear()
  for (const id of Object.keys(identitiesById)) delete identitiesById[id]
  getImRepositoryMock.mockClear()
  for (const fn of Object.values(contactsServiceMock)) (fn as ReturnType<typeof vi.fn>).mockReset()
  refreshChatsMock.mockReset().mockResolvedValue(undefined)
  chatState.chats.length = 0
  contactsServiceMock.getContacts.mockResolvedValue([])
  contactsServiceMock.getContactGroups.mockResolvedValue([])
  contactsServiceMock.getReceivedRequests.mockResolvedValue([])
  contactsServiceMock.getSentRequests.mockResolvedValue([])
  contactsServiceMock.updateContactAlias.mockResolvedValue(undefined)
  contactsServiceMock.removeOwnedAgent.mockResolvedValue(undefined)
  contactsServiceMock.updateOwnedAgentProfile.mockImplementation(async (id: string, fields: { display_name?: string }) => ({
    ...sharedGroupAgent, id, display_name: fields.display_name?.trim() ?? sharedGroupAgent.display_name,
  }))
})

afterEach(async () => {
  await repository?.transaction(() => {})
  repository?.close()
})

describe('ContactsProvider shared-group Agent projection', () => {
  it('publishes an external Agent from an active group row of the chat projection, with the identity the projection carries', async () => {
    const before = readPerfCounters().contactsProviderRenders
    identitiesById[sharedGroupAgent.id] = sharedGroupAgent
    identitiesById['other-owner'] = { ...sharedGroupAgent, id: 'other-owner', display_name: 'Owner', type: 'human', owner_user_id: null }
    chatState.chats.push(sharedGroupRow)
    const harness = await renderProvider()

    try {
      expect(readPerfCounters().contactsProviderRenders).toBeGreaterThan(before)
      expect(store?.sharedGroupAgents).toEqual([sharedGroupAgent])
      expect(store?.groupChats.map((group) => group.id)).toEqual(['group-1'])
      expect(store?.contacts).toEqual([])
      expect(store?.groupChatsStatus).toBe('ready')
    } finally {
      harness.cleanup()
    }
  })
})


describe('offline task rename survives reconnect #898', () => {
  const renamed = (detail: { agentUserId: string; displayName: string; pendingManual?: true }) =>
    act(async () => { window.dispatchEvent(new CustomEvent(UI_EVENTS.ownedAgentRenamed, { detail })); await repository.transaction(() => {}) })

  it('keeps a pending local name against cloud identity reads until the host reports it published', async () => {
    const agent = { ...sharedGroupAgent, owner_user_id: authUser.id, display_name: 'Gamma' }
    identitiesById[agent.id] = agent
    const harness = await renderProvider()
    try {
      await renamed({ agentUserId: agent.id, displayName: 'Delta', pendingManual: true })
      expect(identitiesById[agent.id].display_name).toBe('Delta')
      // Network returns: a projection / sync read still carries the unpublished cloud name.
      await act(async () => { await repository.putIdentities([agent]) })
      expect(identitiesById[agent.id].display_name).toBe('Delta')
      // The host published it; from now on cloud reads are the truth again (a later rename elsewhere wins).
      await renamed({ agentUserId: agent.id, displayName: 'Delta' })
      await act(async () => { await repository.putIdentities([{ ...agent, display_name: 'Epsilon' }]) })
      expect(identitiesById[agent.id].display_name).toBe('Epsilon')
    } finally { harness.cleanup() }
  })

  it('re-seeds the hold from the host after a renderer reload, and releases it once published', async () => {
    const agent = { ...sharedGroupAgent, owner_user_id: authUser.id, display_name: 'Gamma' }
    identitiesById[agent.id] = agent
    pendingNames.push({ conversationId: 'task', agentUserId: agent.id, displayName: 'Delta', pendingManual: true })
    contactsServiceMock.getContacts.mockResolvedValue([agent])
    const harness = await renderProvider()
    try {
      await act(async () => { await repository.putIdentities([agent]) })
      expect(identitiesById[agent.id].display_name).toBe('Delta')
      delete pendingNames[0].pendingManual
      await act(async () => { await revisionConsumers.get('agent_changed')!() })
      await act(async () => { await repository.putIdentities([{ ...agent, display_name: 'Epsilon' }]) })
      expect(identitiesById[agent.id].display_name).toBe('Epsilon')
    } finally { harness.cleanup() }
  })
})

describe('agent rename canonical publication #6021', () => {
  it('validates an avatar before changing its linked task name', async () => {
    pendingNames.push({ conversationId: 'task', agentUserId: sharedGroupAgent.id, displayName: 'Existing' })
    const harness = await renderProvider()
    try {
      await expect(store!.uploadAgentAvatar(sharedGroupAgent.id, new File([], 'empty.png', { type: 'image/png' }), { name: 'Rejected upload' })).rejects.toThrow()
      expect(renameTask).not.toHaveBeenCalled()
      expect(contactsServiceMock.uploadOwnedAgentAvatar).not.toHaveBeenCalled()
    } finally { harness.cleanup() }
  })

  it('retains the assistant profile contract even if a task directory row shares its ID', async () => {
    const agent = { ...sharedGroupAgent, owner_user_id: 'user-1' }
    assistant.id = agent.id
    pendingNames.push({ conversationId: 'task', agentUserId: agent.id, displayName: 'Task label', pendingManual: true })
    const updated = { ...agent, display_name: 'x'.repeat(50), bio: 'Assistant bio' }
    contactsServiceMock.updateOwnedAgentProfile.mockResolvedValue(updated)
    const harness = await renderProvider()
    try {
      await act(async () => { await store!.updateAgentProfile(agent.id, { name: updated.display_name, bio: updated.bio! }) })
      expect(renameTask).not.toHaveBeenCalled()
      expect(contactsServiceMock.updateOwnedAgentProfile).toHaveBeenCalledExactlyOnceWith(agent.id, { display_name: updated.display_name, bio: updated.bio })
      expect(identitiesById[agent.id]).toEqual(updated)
      expect(reportAssistant).toHaveBeenCalledOnce()
    } finally { harness.cleanup() }
  })

  it('renames a bound task through the actual shared shell entry even when an earlier name is pending', async () => {
    const agent = { ...sharedGroupAgent, owner_user_id: 'user-1', display_name: 'Earlier task choice' }
    identitiesById[agent.id] = agent
    pendingNames.push({ conversationId: 'task', agentUserId: agent.id, displayName: agent.display_name, pendingManual: true })
    const harness = await renderProvider()
    try {
      await act(async () => { await store!.renameAgent(agent.id, '  Later profile choice  ') })
      expect(renameTask).toHaveBeenCalledExactlyOnceWith({ sessionId: 'task', name: '  Later profile choice  ' })
      expect(contactsServiceMock.updateOwnedAgentProfile).not.toHaveBeenCalled()
      expect(renameLocal).not.toHaveBeenCalled()
      expect(identitiesById[agent.id].display_name).toBe('Later profile choice')
    } finally { harness.cleanup() }
  })

  it('keeps the task name operation separate from a later bio response containing an old cloud name', async () => {
    const agent = { ...sharedGroupAgent, owner_user_id: 'user-1' }
    identitiesById[agent.id] = agent
    pendingNames.push({ conversationId: 'task', agentUserId: agent.id, displayName: agent.display_name })
    contactsServiceMock.updateOwnedAgentProfile.mockResolvedValue({ ...agent, bio: 'Updated bio' })
    const harness = await renderProvider()
    try {
      await act(async () => { await store!.updateAgentProfile(agent.id, { name: 'Profile choice', bio: 'Updated bio' }) })
      expect(contactsServiceMock.updateOwnedAgentProfile).toHaveBeenCalledExactlyOnceWith(agent.id, { bio: 'Updated bio' })
      expect(renameTask).toHaveBeenCalledOnce()
      expect(renameLocal).not.toHaveBeenCalled()
      expect(identitiesById[agent.id]).toMatchObject({ display_name: 'Profile choice', bio: 'Updated bio' })
    } finally { harness.cleanup() }
  })

  it('uses the same task rename operation when an avatar upload includes a name', async () => {
    const agent = { ...sharedGroupAgent, owner_user_id: 'user-1' }
    identitiesById[agent.id] = agent
    pendingNames.push({ conversationId: 'task', agentUserId: agent.id, displayName: agent.display_name })
    contactsServiceMock.uploadOwnedAgentAvatar.mockResolvedValue({ ...agent, avatar: 'avatar.png' })
    const harness = await renderProvider()
    try {
      const file = new File(['avatar'], 'avatar.png', { type: 'image/png' })
      await act(async () => { await store!.uploadAgentAvatar(agent.id, file, { name: 'Avatar choice', bio: 'Bio' }) })
      expect(renameTask).toHaveBeenCalledExactlyOnceWith({ sessionId: 'task', name: 'Avatar choice' })
      expect(contactsServiceMock.uploadOwnedAgentAvatar).toHaveBeenCalledExactlyOnceWith(agent.id, file, { bio: 'Bio' })
      expect(renameLocal).not.toHaveBeenCalled()
      expect(identitiesById[agent.id]).toMatchObject({ display_name: 'Avatar choice', avatar: 'avatar.png' })
    } finally { harness.cleanup() }
  })

  it('publishes the confirmed identity and normalized name through the existing local persistence bridge', async () => {
    const updated = { ...sharedGroupAgent, owner_user_id: 'user-1', display_name: '新名字' }
    contactsServiceMock.updateOwnedAgentProfile.mockResolvedValue(updated)
    const harness = await renderProvider()
    try {
      await act(async () => { await store!.renameAgent(updated.id, '  新名字  ') })
      expect(contactsServiceMock.updateOwnedAgentProfile).toHaveBeenCalledWith(updated.id, { display_name: '  新名字  ' })
      expect(identitiesById[updated.id]).toEqual(updated)
      expect(renameLocal).toHaveBeenCalledExactlyOnceWith(updated.id, '新名字')
      expect(refreshChatsMock).toHaveBeenCalledOnce()
    } finally { harness.cleanup() }
  })
  it('merges pending intent over a successful old cloud snapshot and keeps the sidebar current', async () => {
    const agent = { ...sharedGroupAgent, owner_user_id: 'user-1' }
    identitiesById[agent.id] = agent
    const directory = { getSnapshot: () => identitiesById as IdentityDirectorySnapshot,
      subscribe: (notify: () => void) => { identityListeners.add(notify); return () => { identityListeners.delete(notify) } }, ensure: () => {} }
    const names = new SessionAgentNames({ readAll: () => null, readRemote: () => [], onRemoteChange: () => () => {}, onIdentityEvent: () => () => {}, directory: () => directory })
    names.note('task', agent.display_name, agent.id)
    names.start()
    const harness = await renderProvider()
    try {
      pendingNames.push({ conversationId: 'task', agentUserId: agent.id, displayName: 'Local choice', pendingManual: true })
      const before = contactsServiceMock.getContacts.mock.calls.length
      await act(async () => { window.dispatchEvent(new CustomEvent(UI_EVENTS.ownedAgentRenamed, { detail: { agentUserId: agent.id, displayName: 'Local choice' } })) })
      expect(contactsServiceMock.getContacts).toHaveBeenCalledTimes(before)
      expect(names.displayNameFor('task', 'claude', agent.display_name)).toBe('Local choice')
      contactsServiceMock.getContacts.mockResolvedValueOnce([agent])
      await act(async () => { await store!.refreshContacts() })
      expect(names.nameFor('task')).toBe('Local choice')
      // The existing host onSubscribed synchronization has now published the same chosen name.
      pendingNames.length = 0
      contactsServiceMock.getContacts.mockResolvedValueOnce([{ ...agent, display_name: 'Local choice' }])
      await act(async () => { await store!.refreshContacts() })
      expect(names.nameFor('task')).toBe('Local choice')
      expect(identitiesById[agent.id].display_name).toBe('Local choice')
    } finally { harness.cleanup() }
  })

  it('merges one pending agent without dropping a strict in-flight revision refresh or its other contacts', async () => {
    const agent = { ...sharedGroupAgent, owner_user_id: 'user-1' }
    const other: ContactUser = { ...sharedGroupAgent, id: 'another-agent', display_name: 'Other current name' }
    identitiesById[agent.id] = agent
    const harness = await renderProvider()
    try {
      let release!: (rows: ContactUser[]) => void
      contactsServiceMock.getContacts.mockImplementationOnce(() => new Promise<ContactUser[]>((resolve) => { release = resolve }))
      let reading!: Promise<void>
      await act(async () => { reading = revisionConsumers.get('agent_changed')!() })
      pendingNames.push({ conversationId: 'task', agentUserId: agent.id, displayName: 'Local choice', pendingManual: true })
      await act(async () => { window.dispatchEvent(new CustomEvent(UI_EVENTS.ownedAgentRenamed, { detail: { agentUserId: agent.id, displayName: 'Local choice' } })) })
      await act(async () => { release([agent, other]); await reading })
      expect(identitiesById[agent.id].display_name).toBe('Local choice')
      expect(identitiesById[other.id].display_name).toBe('Other current name')
      expect(store!.contacts.map((contact) => contact.id)).toEqual([agent.id, other.id])
      expect(store!.contactsStatus).toBe('ready')
    } finally { harness.cleanup() }
  })

  it('finishes the first contact load after a local rename instead of remaining in loading', async () => {
    const agent = { ...sharedGroupAgent, owner_user_id: 'user-1' }
    let release!: (rows: ContactUser[]) => void
    contactsServiceMock.getContacts.mockImplementationOnce(() => new Promise<ContactUser[]>((resolve) => { release = resolve }))
    const harness = await renderProvider()
    try {
      expect(store!.contactsStatus).toBe('loading')
      pendingNames.push({ conversationId: 'task', agentUserId: agent.id, displayName: 'Local choice', pendingManual: true })
      await act(async () => { window.dispatchEvent(new CustomEvent(UI_EVENTS.ownedAgentRenamed, { detail: { agentUserId: agent.id, displayName: 'Local choice' } })) })
      await act(async () => { release([agent]); await Promise.resolve() })
      expect(store!.contactsStatus).toBe('ready')
      expect(identitiesById[agent.id].display_name).toBe('Local choice')
      expect(store!.contacts.map((contact) => contact.id)).toEqual([agent.id])
    } finally { harness.cleanup() }
  })

  it('does not publish a rejected owner mutation to either identity or local roster', async () => {
    contactsServiceMock.updateOwnedAgentProfile.mockRejectedValue(new Error('permission denied'))
    const harness = await renderProvider()
    try {
      await expect(store!.renameAgent('other-agent', 'New')).rejects.toThrow('permission denied')
      expect(identitiesById['other-agent']).toBeUndefined()
      expect(renameLocal).not.toHaveBeenCalled()
      expect(refreshChatsMock).not.toHaveBeenCalled()
    } finally { harness.cleanup() }
  })
  it('reports a local persistence failure and permits retry without replacing the identity', async () => {
    const updated = { ...sharedGroupAgent, owner_user_id: 'user-1', display_name: '新名字' }
    contactsServiceMock.updateOwnedAgentProfile.mockResolvedValue(updated)
    renameLocal.mockRejectedValueOnce(new Error('roster unavailable'))
    const harness = await renderProvider()
    try {
      await expect(store!.renameAgent(updated.id, '新名字')).rejects.toThrow('roster unavailable')
      expect(identitiesById[updated.id]).toEqual(updated)
      await act(async () => { await store!.renameAgent(updated.id, '新名字') })
      expect(renameLocal).toHaveBeenCalledTimes(2)
      expect(identitiesById[updated.id].id).toBe(sharedGroupAgent.id)
    } finally { harness.cleanup() }
  })
})
vi.mock('../../../../apps/desktop/src/lib/groupInvitations', () => ({ listGroupInvitations: vi.fn(async () => []) }))

describe('actual repository identity publication ordering', () => {
  it.each([true, false])('keeps a rename during first hydration with an existing identity: %s', async (cached) => {
    const agent = { ...sharedGroupAgent, owner_user_id: authUser.id, display_name: 'Earlier local', bio: 'Hydrated metadata' }
    if (cached) identitiesById[agent.id] = agent
    pendingNames.push({ conversationId: 'task', agentUserId: agent.id, displayName: agent.display_name, pendingManual: true })
    const harness = await renderProvider()
    contactsServiceMock.getContacts.mockResolvedValueOnce([agent])
    const held = holdNamesResponse()
    try {
      const { pending: loading } = await beginUpdate(() => store!.refreshContacts())
      await held.wait()
      expect(held.captured()).toMatchObject([{ displayName: 'Earlier local', pendingManual: true }])
      await act(async () => { await desktopPort.renameAgent({ sessionId: 'task', name: 'Newest local' }); await repository.transaction(() => {}) })
      expect(identitiesById[agent.id]?.display_name).toBe(cached ? 'Newest local' : undefined)
      expect(pendingNames[0].displayName).toBe('Newest local')
      await act(async () => { held.release(); await loading })
      expect(identitiesById[agent.id]).toMatchObject({ display_name: 'Newest local', bio: 'Hydrated metadata' })
      expect(store!.contactsStatus).toBe('ready')
    } finally { held.release(); held.restore(); harness.cleanup() }
  })

  it('merges pending intent that predates the first complete identity row', async () => {
    pendingNames.push({ conversationId: 'task', agentUserId: sharedGroupAgent.id, displayName: 'Newest local', pendingManual: true })
    const harness = await renderProvider()
    try {
      await act(async () => { await desktopPort.renameAgent({ sessionId: 'task', name: 'Newest local' }); await repository.transaction(() => {}) })
      expect(identitiesById[sharedGroupAgent.id]).toBeUndefined()
      contactsServiceMock.getContacts.mockResolvedValueOnce([{ ...sharedGroupAgent, bio: 'Hydrated metadata' }])
      await act(async () => { await store!.refreshContacts() })
      expect(identitiesById[sharedGroupAgent.id]).toMatchObject({ display_name: 'Newest local', bio: 'Hydrated metadata' })
      expect(store!.contactsStatus).toBe('ready')
    } finally { harness.cleanup() }
  })

  it.each(['public', 'status', 'search'])('keeps current names in the shared %s identity publication path', async (kind) => {
    const agent = pendingAgent()
    const updated = { ...agent, display_name: 'Old cloud', agent_public: true, desired_status: 'offline' as const }
    contactsServiceMock.setAgentPublic.mockResolvedValueOnce(updated)
    contactsServiceMock.setAgentDesiredStatus.mockResolvedValueOnce(updated)
    contactsServiceMock.searchUsers.mockResolvedValueOnce([updated])
    const harness = await renderProvider()
    const held = holdNamesResponse()
    try {
      const { pending: updating } = await beginUpdate(() => kind === 'public' ? store!.setAgentPublic(agent.id, true)
        : kind === 'status' ? store!.setAgentDesiredStatus(agent.id, 'offline') : store!.searchUsers('query'))
      await held.wait()
      await act(async () => { await desktopPort.renameAgent({ sessionId: 'task', name: 'Newest local' }) })
      await act(async () => { held.release(); await updating })
      expect(identitiesById[agent.id]).toMatchObject({ display_name: 'Newest local', agent_public: true, desired_status: 'offline' })
    } finally { held.release(); held.restore(); harness.cleanup() }
  })

  it('reads the current pending name after a delayed metadata response', async () => {
    const agent = pendingAgent()
    let release!: (value: ContactUser) => void
    contactsServiceMock.updateOwnedAgentProfile.mockImplementationOnce(() => new Promise<ContactUser>((resolve) => { release = resolve }))
    const harness = await renderProvider()
    try {
      const { pending: updating } = await beginUpdate(() => store!.updateAgentProfile(agent.id, { bio: 'Metadata' }))
      await vi.waitFor(() => expect(release).toBeTypeOf('function'))
      await act(async () => { await desktopPort.renameAgent({ sessionId: 'task', name: 'Newest local' }) })
      expect(identitiesById[agent.id].display_name).toBe('Newest local')
      await act(async () => { release({ ...agent, display_name: 'Old cloud', bio: 'Metadata' }); await updating })
      expect(identitiesById[agent.id]).toMatchObject({ display_name: 'Newest local', bio: 'Metadata' })
    } finally { harness.cleanup() }
  })

  it.each(['bio', 'avatar'])('keeps a newer published name when an old %s names response arrives late', async (kind) => {
    const agent = pendingAgent()
    const updated = { ...agent, display_name: 'Old cloud', bio: 'Metadata', avatar: 'avatar.png' }
    contactsServiceMock.updateOwnedAgentProfile.mockResolvedValueOnce(updated)
    contactsServiceMock.uploadOwnedAgentAvatar.mockResolvedValueOnce(updated)
    const harness = await renderProvider()
    const held = holdNamesResponse()
    try {
      const { pending: updating } = await beginUpdate(() => kind === 'bio' ? store!.updateAgentProfile(agent.id, { bio: 'Metadata' })
        : store!.uploadAgentAvatar(agent.id, new File(['avatar'], 'avatar.png', { type: 'image/png' })))
      await held.wait()
      expect(held.captured()).toMatchObject([{ displayName: 'Earlier local', pendingManual: true }])
      await act(async () => { await desktopPort.renameAgent({ sessionId: 'task', name: 'Newest local' }) })
      expect(identitiesById[agent.id].display_name).toBe('Newest local')
      await act(async () => { held.release(); await updating })
      expect(identitiesById[agent.id]).toMatchObject({ display_name: 'Newest local', bio: 'Metadata', avatar: 'avatar.png' })
      expect(pendingNames[0].displayName).toBe('Newest local')
    } finally { held.release(); held.restore(); harness.cleanup() }
  })

  it('uses the same final merge for a delayed contacts response without dropping other identities', async () => {
    const agent = pendingAgent()
    const other = { ...sharedGroupAgent, id: 'other-agent', display_name: 'Other current', bio: 'Other metadata' }
    const harness = await renderProvider()
    contactsServiceMock.getContacts.mockResolvedValueOnce([{ ...agent, bio: 'Metadata' }, other])
    const held = holdNamesResponse()
    try {
      const { pending: loading } = await beginUpdate(() => store!.refreshContacts())
      await held.wait()
      await act(async () => { await desktopPort.renameAgent({ sessionId: 'task', name: 'Newest local' }) })
      await act(async () => { held.release(); await loading })
      expect(identitiesById[agent.id]).toMatchObject({ display_name: 'Newest local', bio: 'Metadata' })
      expect(identitiesById[other.id]).toMatchObject(other)
      expect(store!.contacts.map((row) => row.id)).toEqual([agent.id, other.id])
      expect(store!.contactsStatus).toBe('ready')
    } finally { held.release(); held.restore(); harness.cleanup() }
  })

  it('compares names inside the queued transaction after an earlier rename commit', async () => {
    const agent = pendingAgent()
    contactsServiceMock.updateOwnedAgentProfile.mockResolvedValueOnce({ ...agent, display_name: 'Old cloud', bio: 'Metadata' })
    const harness = await renderProvider()
    const held = holdNamesResponse()
    let releaseBlock!: () => void
    let blocking: Promise<void> | undefined
    const transaction = vi.spyOn(repository, 'transaction')
    try {
      const { pending: updating } = await beginUpdate(() => store!.updateAgentProfile(agent.id, { bio: 'Metadata' }))
      await held.wait()
      let entered!: () => void
      const started = new Promise<void>((resolve) => { entered = resolve })
      blocking = repository.transaction(async () => { entered(); await new Promise<void>((resolve) => { releaseBlock = resolve }) })
      await started
      await act(async () => { await desktopPort.renameAgent({ sessionId: 'task', name: 'Newest local' }) })
      expect(pendingNames[0].displayName).toBe('Newest local')
      expect(identitiesById[agent.id].display_name).toBe('Earlier local')
      const queued = transaction.mock.calls.length
      held.release()
      await vi.waitFor(() => expect(transaction.mock.calls.length).toBeGreaterThan(queued))
      await act(async () => { releaseBlock(); await blocking; await updating })
      expect(identitiesById[agent.id]).toMatchObject({ display_name: 'Newest local', bio: 'Metadata' })
    } finally { held.release(); releaseBlock?.(); await blocking; held.restore(); transaction.mockRestore(); harness.cleanup() }
  })

  it('applies a queued rename to the current row without losing an earlier metadata commit', async () => {
    const agent = pendingAgent()
    const harness = await renderProvider()
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const blocking = repository.transaction(async () => { entered(); await new Promise<void>((resolve) => { release = resolve }) })
    try {
      await started
      const metadata = repository.putIdentities([{ ...agent, bio: 'Queued metadata' }])
      await act(async () => { await desktopPort.renameAgent({ sessionId: 'task', name: 'Newest local' }) })
      await act(async () => { release(); await blocking; await metadata; await repository.transaction(() => {}) })
      expect(identitiesById[agent.id]).toMatchObject({ display_name: 'Newest local', bio: 'Queued metadata' })
    } finally { release?.(); await blocking; harness.cleanup() }
  })

  it('does not commit metadata from a superseded strict refresh after its names response returns', async () => {
    const agent = pendingAgent()
    const harness = await renderProvider()
    contactsServiceMock.getContacts.mockResolvedValueOnce([{ ...agent, bio: 'Old metadata' }])
    const held = holdNamesResponse()
    try {
      const { pending: older } = await beginUpdate(() => revisionConsumers.get('agent_changed')!())
      await held.wait()
      contactsServiceMock.getContacts.mockResolvedValueOnce([{ ...agent, bio: 'Current metadata' }])
      await act(async () => { await store!.refreshContacts() })
      await act(async () => { held.release(); await older })
      expect(identitiesById[agent.id].bio).toBe('Current metadata')
      expect(store!.contactsStatus).toBe('ready')
    } finally { held.release(); held.restore(); harness.cleanup() }
  })

  it('still rejects a superseded strict refresh when its names read fails', async () => {
    const agent = pendingAgent()
    const harness = await renderProvider()
    contactsServiceMock.getContacts.mockResolvedValueOnce([agent])
    const held = holdNamesResponse()
    try {
      const { pending: older } = await beginUpdate(() => revisionConsumers.get('agent_changed')!())
      const rejected = expect(older).rejects.toThrow('identity refresh unavailable')
      await held.wait()
      contactsServiceMock.getContacts.mockResolvedValueOnce([{ ...agent, bio: 'Current metadata' }])
      await act(async () => { await store!.refreshContacts() })
      await act(async () => { held.reject(new Error('identity refresh unavailable')); await rejected })
      expect(identitiesById[agent.id].bio).toBe('Current metadata')
    } finally { held.release(); held.restore(); harness.cleanup() }
  })
})


describe('single identity publication through the real directory', () => {
  it.each([false, true])('keeps known pending names with no raw first publication; names rejects: %s', async (rejectNames) => {
    const agent = { ...sharedGroupAgent, owner_user_id: authUser.id, display_name: 'Old cloud', bio: 'Complete cloud metadata' }
    pendingNames.push({ conversationId: 'task', agentUserId: agent.id, displayName: 'Newest local', pendingManual: true })
    const listeners = observeRenameListeners()
    const harness = await renderProvider()
    const baseline = listeners.count()
    expect(baseline).toBeGreaterThan(0)
    const known = await desktopPort.agentNames()
    installIdentityDirectoryBridge()
    const bridge = readIdentityDirectoryBridge()!
    const subscriptions: Array<() => void> = []
    const names = new SessionAgentNames({
      readAll: () => null, readRemote: () => [], onRemoteChange: () => () => {}, onIdentityEvent: () => () => {},
      directory: () => ({ ...bridge, subscribe: (listener) => { const stop = bridge.subscribe(listener); subscriptions.push(stop); return stop } }),
    })
    for (const row of known) names.note(row.conversationId, row.displayName, row.agentUserId)
    const publications: Array<{ identity: string | undefined; taskView: string | undefined }> = []
    const stop = repository.subscribe(imSelectors.identitiesById, (rows) => {
      publishIdentityDirectory(rows, null)
      publications.push({ identity: rows[agent.id]?.display_name, taskView: names.nameFor('task') })
    })
    names.start()
    const held = holdNamesResponse()
    contactsServiceMock.getContacts.mockResolvedValueOnce([agent])
    try {
      const { pending: loading } = await beginUpdate(() => revisionConsumers.get('agent_changed')!())
      const result = loading.then(() => ({ ok: true }), (error: Error) => ({ ok: false, error: error.message }))
      await held.wait()
      expect(listeners.count()).toBe(baseline + 1)
      expect(names.nameFor('task')).toBe('Newest local')
      expect(identitiesById[agent.id]).toBeUndefined()
      await act(async () => {
        if (rejectNames) held.reject(new Error('names transport unavailable'))
        else held.release()
        expect(await result).toEqual(rejectNames ? { ok: false, error: 'names transport unavailable' } : { ok: true })
      })
      expect(listeners.count()).toBe(baseline)
      expect(store!.contactsStatus).toBe(rejectNames ? 'error' : 'ready')
      expect(names.nameFor('task')).toBe('Newest local')
      expect(pendingNames[0].displayName).toBe('Newest local')
      expect(publications.every((row) => row.identity === undefined || row.identity === 'Newest local')).toBe(true)
      expect(publications.filter((row) => row.identity !== undefined)).toHaveLength(rejectNames ? 0 : 1)
      if (!rejectNames) expect(identitiesById[agent.id]).toMatchObject({ display_name: 'Newest local', bio: agent.bio })
    } finally {
      held.release(); held.restore(); stop()
      for (const unsubscribe of subscriptions) unsubscribe()
      publishIdentityDirectory(null, null)
      harness.cleanup(); listeners.restore()
    }
  })

  it('retains cold rename events until the queued final publication commits', async () => {
    const agent = { ...sharedGroupAgent, owner_user_id: authUser.id, display_name: 'Earlier local', bio: 'Metadata' }
    pendingNames.push({ conversationId: 'task', agentUserId: agent.id, displayName: agent.display_name, pendingManual: true })
    const listeners = observeRenameListeners()
    const harness = await renderProvider()
    const baseline = listeners.count()
    contactsServiceMock.getContacts.mockResolvedValueOnce([agent])
    const held = holdNamesResponse()
    const transaction = vi.spyOn(repository, 'transaction')
    const publications: string[] = []
    const unsubscribe = repository.subscribe(imSelectors.identitiesById, (rows) => {
      const name = rows[agent.id]?.display_name
      if (name) publications.push(name)
    })
    let release!: () => void
    let blocking: Promise<void> | undefined
    try {
      const { pending: loading } = await beginUpdate(() => store!.refreshContacts())
      await held.wait()
      let entered!: () => void
      const started = new Promise<void>((resolve) => { entered = resolve })
      blocking = repository.transaction(async () => { entered(); await new Promise<void>((resolve) => { release = resolve }) })
      await started
      const queued = transaction.mock.calls.length
      held.release()
      await vi.waitFor(() => expect(transaction.mock.calls.length).toBeGreaterThan(queued))
      expect(listeners.count()).toBe(baseline + 1)
      await act(async () => { await desktopPort.renameAgent({ sessionId: 'task', name: 'Newest local' }) })
      expect(identitiesById[agent.id]).toBeUndefined()
      await act(async () => { release(); await blocking; await loading; await repository.transaction(() => {}) })
      expect(listeners.count()).toBe(baseline)
      expect(publications).not.toContain('Earlier local')
      expect(publications[0]).toBe('Newest local')
      expect(identitiesById[agent.id]).toMatchObject({ display_name: 'Newest local', bio: 'Metadata' })
    } finally {
      release?.(); await blocking; unsubscribe(); transaction.mockRestore()
      held.release(); held.restore(); harness.cleanup(); listeners.restore()
    }
  })

  it.each([false, true])('retains newer canonical repository names without an event; queued: %s', async (queued) => {
    const agent = pendingAgent()
    delete pendingNames[0].pendingManual
    const harness = await renderProvider()
    contactsServiceMock.updateOwnedAgentProfile.mockResolvedValueOnce({ ...agent, display_name: 'Old cloud', bio: 'Incoming metadata' })
    const held = holdNamesResponse()
    const transaction = vi.spyOn(repository, 'transaction')
    let release!: () => void
    let blocking: Promise<void> | undefined
    try {
      const { pending: updating } = await beginUpdate(() => store!.updateAgentProfile(agent.id, { bio: 'Incoming metadata' }))
      await held.wait()
      if (queued) {
        let entered!: () => void
        const started = new Promise<void>((resolve) => { entered = resolve })
        blocking = repository.transaction(async () => { entered(); await new Promise<void>((resolve) => { release = resolve }) })
        await started
      }
      const canonical = repository.putIdentities([{ ...agent, display_name: 'New canonical', bio: 'Current metadata' }])
      if (queued) {
        const before = transaction.mock.calls.length
        held.release()
        await vi.waitFor(() => expect(transaction.mock.calls.length).toBeGreaterThan(before))
        await act(async () => { release(); await blocking; await canonical; await updating })
      } else {
        await act(async () => { await canonical; held.release(); await updating })
      }
      expect(identitiesById[agent.id]).toMatchObject({ display_name: 'New canonical', bio: 'Incoming metadata' })
    } finally { release?.(); await blocking; transaction.mockRestore(); held.release(); held.restore(); harness.cleanup() }
  })

  it('prefers the new rename event over an older canonical row queued ahead of final publication', async () => {
    const agent = pendingAgent()
    const harness = await renderProvider()
    contactsServiceMock.updateOwnedAgentProfile.mockResolvedValueOnce({ ...agent, display_name: 'Old cloud', bio: 'Incoming metadata' })
    const held = holdNamesResponse()
    const transaction = vi.spyOn(repository, 'transaction')
    const publications: Array<{ name: string; bio: string | null | undefined }> = []
    const unsubscribe = repository.subscribe(imSelectors.identitiesById, (rows) => {
      const row = rows[agent.id]
      if (row) publications.push({ name: row.display_name, bio: row.bio })
    })
    let release!: () => void
    let blocking: Promise<void> | undefined
    try {
      const { pending: updating } = await beginUpdate(() => store!.updateAgentProfile(agent.id, { bio: 'Incoming metadata' }))
      await held.wait()
      let entered!: () => void
      const started = new Promise<void>((resolve) => { entered = resolve })
      blocking = repository.transaction(async () => { entered(); await new Promise<void>((resolve) => { release = resolve }) })
      await started
      const snapshot = repository.putIdentities([{ ...agent, display_name: 'Intermediate canonical', bio: 'Earlier metadata' }])
      const before = transaction.mock.calls.length
      held.release()
      await vi.waitFor(() => expect(transaction.mock.calls.length).toBeGreaterThan(before))
      await act(async () => { await desktopPort.renameAgent({ sessionId: 'task', name: 'Newest local' }) })
      await act(async () => { release(); await blocking; await snapshot; await updating; await repository.transaction(() => {}) })
      const merged = publications.filter((row) => row.bio === 'Incoming metadata')
      expect(merged.length).toBeGreaterThan(0)
      expect(merged.every((row) => row.name === 'Newest local'), JSON.stringify(merged)).toBe(true)
      expect(pendingNames[0].displayName).toBe('Newest local')
    } finally {
      release?.(); await blocking; unsubscribe(); transaction.mockRestore(); held.release(); held.restore(); harness.cleanup()
    }
  })

  it('removes the read listener when the repository write throws', async () => {
    const agent = pendingAgent()
    const listeners = observeRenameListeners()
    const harness = await renderProvider()
    const baseline = listeners.count()
    contactsServiceMock.getContacts.mockResolvedValueOnce([agent])
    const held = holdNamesResponse()
    const transaction = vi.spyOn(repository, 'transaction')
    try {
      const { pending: loading } = await beginUpdate(() => revisionConsumers.get('agent_changed')!())
      const rejected = expect(loading).rejects.toThrow('identity commit unavailable')
      await held.wait()
      expect(listeners.count()).toBe(baseline + 1)
      transaction.mockRejectedValueOnce(new Error('identity commit unavailable'))
      await act(async () => { held.release(); await rejected })
      expect(listeners.count()).toBe(baseline)
      expect(store!.contactsStatus).toBe('error')
      transaction.mockRestore()
      const before = identitiesById[agent.id].display_name
      await act(async () => { window.dispatchEvent(new CustomEvent(UI_EVENTS.ownedAgentRenamed, { detail: { agentUserId: 'unrelated-agent', displayName: 'Unrelated choice' } })); await repository.transaction(() => {}) })
      expect(identitiesById[agent.id].display_name).toBe(before)
      expect(listeners.count()).toBe(baseline)
    } finally { transaction.mockRestore(); held.release(); held.restore(); harness.cleanup(); listeners.restore() }
  })

  it('removes a superseded read listener without dropping the newer publication', async () => {
    const agent = pendingAgent()
    const listeners = observeRenameListeners()
    const harness = await renderProvider()
    const baseline = listeners.count()
    contactsServiceMock.getContacts.mockResolvedValueOnce([{ ...agent, bio: 'Superseded metadata' }])
    const held = holdNamesResponse()
    try {
      const { pending: older } = await beginUpdate(() => revisionConsumers.get('agent_changed')!())
      await held.wait()
      expect(listeners.count()).toBe(baseline + 1)
      contactsServiceMock.getContacts.mockResolvedValueOnce([{ ...agent, bio: 'Current metadata' }])
      await act(async () => { await store!.refreshContacts() })
      expect(listeners.count()).toBe(baseline + 1)
      await act(async () => { held.release(); await older })
      expect(listeners.count()).toBe(baseline)
      expect(identitiesById[agent.id].bio).toBe('Current metadata')
      expect(store!.contactsStatus).toBe('ready')
    } finally { held.release(); held.restore(); harness.cleanup(); listeners.restore() }
  })
})
