// @vitest-environment jsdom
// #5661 通讯录里的外部 Agent 只来自共同 active group。群和成员 id 来自会话投影,身份就是投影带回来的那份
// (投影只把身份已到的成员放进 member_user_ids),❌ 另拉一张群表、另读一遍身份。
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createNode, createReactHarness } from '../../../support/testHarness'
import type { ContactUser } from '@gugu/core/shared/types/contacts'

const { authUser, contactsServiceMock, identitiesById, putIdentitiesMock, getImRepositoryMock, refreshChatsMock, chatState } = vi.hoisted(() => {
  const identitiesById = {} as Record<string, ContactUser>
  const putIdentitiesMock = vi.fn(async (identities: ContactUser[]) => {
    for (const identity of identities) identitiesById[identity.id] = identity
  })
  return {
    authUser: { id: 'user-1', email: 'user@example.test', nickname: 'User One' },
    identitiesById,
    putIdentitiesMock,
    getImRepositoryMock: vi.fn(async () => ({ putIdentities: putIdentitiesMock })),
    contactsServiceMock: {
      getContacts: vi.fn(),
      getContactGroups: vi.fn(),
      getReceivedRequests: vi.fn(),
      getSentRequests: vi.fn(),
      updateContactAlias: vi.fn(),
      removeOwnedAgent: vi.fn(),
      updateOwnedAgentProfile: vi.fn(),
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
    subscribeAccountRevision: () => () => undefined,
  }),
}))
vi.mock('../../../../apps/desktop/src/lib/contacts', () => ({ contactsService: contactsServiceMock }))

const { renameLocal, releaseLocal, notify } = vi.hoisted(() => ({ renameLocal: vi.fn(), releaseLocal: vi.fn(), notify: vi.fn() }))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: { renameOwnedAgentLocalFootprint: renameLocal, releaseOwnedAgentLocalFootprint: releaseLocal } }))
vi.mock('../../../../apps/desktop/src/lib/notices', () => ({ notify }))

import { ContactsProvider } from '../../../../apps/desktop/src/store/contacts'
import { readPerfCounters } from '../../../../apps/desktop/src/lib/perfCounters'
import { useContactsStore, type ContactsContextValue } from '../../../../apps/desktop/src/store/contactsContext'

let store: ContactsContextValue | null = null
function Capture() {
  store = useContactsStore()
  return null
}

async function flushReact(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

async function renderProvider() {
  const harness = createReactHarness()
  await harness.render(createNode(ContactsProvider, null, createNode(Capture)))
  await flushReact()
  return harness
}

const sharedGroupAgent: ContactUser = {
  id: 'shared-agent',
  display_name: 'Shared Agent',
  avatar: null,
  bio: null,
  type: 'agent',
  owner_user_id: 'other-owner',
}
const sharedGroupRow = {
  id: 'group-1', kind: 'group' as const, status: 'active' as const, name: 'Small group', created_at: '2026-10-01T00:00:00Z',
  last_message_at: null, last_message_preview: null, unread_count: 0, pinned_message_id: null, last_read_seq: 0, next_message_seq: 1,
  member_user_ids: ['user-1', 'other-owner', sharedGroupAgent.id],
}

beforeEach(() => {
  renameLocal.mockReset().mockResolvedValue(undefined)
  releaseLocal.mockReset().mockResolvedValue(undefined)
  notify.mockReset()
  store = null
  for (const id of Object.keys(identitiesById)) delete identitiesById[id]
  putIdentitiesMock.mockReset().mockImplementation(async (identities: ContactUser[]) => {
    for (const identity of identities) identitiesById[identity.id] = identity
  })
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
})

describe('ContactsProvider shared-group Agent projection', () => {
  it('publishes an external Agent from an active group row of the chat projection, with the identity the projection carries', async () => {
    const before = readPerfCounters().contactsProviderRenders
    identitiesById[sharedGroupAgent.id] = sharedGroupAgent
    identitiesById['other-owner'] = { id: 'other-owner', display_name: 'Owner', avatar: null, bio: null, type: 'human' }
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


describe('agent rename canonical publication #6021', () => {
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

describe('confirmed Agent deletion has one identity receipt', () => {
  it('announces success before waiting for local cleanup', async () => {
    let finishCleanup!: () => void
    releaseLocal.mockImplementation(() => new Promise<void>(resolve => { finishCleanup = resolve }))
    const harness = await renderProvider()
    try {
      let removal!: Promise<void>
      await act(async () => { removal = store!.removeOwnedAgent('agent-1'); await Promise.resolve() })
      expect(contactsServiceMock.removeOwnedAgent).toHaveBeenCalledExactlyOnceWith('agent-1')
      expect(notify).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ tier: 'success' }))
      await act(async () => { finishCleanup(); await removal })
      expect(notify).toHaveBeenCalledOnce()
    } finally { harness.cleanup() }
  })
  it('does not report a rejected identity deletion as success or begin cleanup', async () => {
    contactsServiceMock.removeOwnedAgent.mockRejectedValue(new Error('identity denied'))
    const harness = await renderProvider()
    try {
      await expect(store!.removeOwnedAgent('agent-1')).rejects.toThrow('identity denied')
      expect(notify).not.toHaveBeenCalled()
      expect(releaseLocal).not.toHaveBeenCalled()
    } finally { harness.cleanup() }
  })
  it.each(['cleanup', 'refresh'])('preserves the success receipt when post-delete %s fails', async stage => {
    const harness = await renderProvider()
    try {
      if (stage === 'cleanup') releaseLocal.mockRejectedValue(new Error('cannot cancel its in-flight turn'))
      else refreshChatsMock.mockRejectedValue(new Error('refresh unavailable'))
      await act(async () => { await expect(store!.removeOwnedAgent('agent-1')).resolves.toBeUndefined() })
      expect(notify).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ tier: 'success' }))
    } finally { harness.cleanup() }
  })
})
