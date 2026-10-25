// @vitest-environment jsdom
// 入群申请推到审批人:gugu-supabase 给群主、管理员和发起人发 friend_requests_changed,收到就重读我管的群的入群申请
// —— 不点开「新的请求」,左栏通讯录的计数也当场有(从前只在登录时、打开「新的请求」时各读一次,#6418)。
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createNode, createReactHarness } from '../../../support/testHarness'
import type { ContactGroupChat } from '@gugu/core/shared/types/contacts'
import type { ManagedGroupJoinRequest } from '../../../../apps/desktop/src/lib/groupJoinRequests'

// The chat store's functions keep one identity across renders, as the real store's do: the provider's loaders are
// callbacks over them, and a new one each render would reload without end.
const { authUser, authOverride, contactsServiceMock, revisionHandlers, listManagedMock, chatStore } = vi.hoisted(() => {
  const revisionHandlers = new Map<string, () => Promise<void> | void>()
  const repository = { putIdentities: async () => undefined }
  return {
    authUser: { id: 'user-1', email: 'user@example.test', nickname: 'User One' },
    authOverride: { current: null as null | { id: string; email: string; nickname: string } },
    contactsServiceMock: {
      getContacts: vi.fn(),
      getContactGroups: vi.fn(),
      getReceivedRequests: vi.fn(),
      getSentRequests: vi.fn(),
    },
    revisionHandlers,
    listManagedMock: vi.fn(),
    chatStore: {
      refreshChats: vi.fn(),
      // 会话投影里我当群主的那条群(通讯录的「群聊」从它派生)。
      chats: [{
        id: 'g-1', kind: 'group', status: 'active', name: '合作方群', created_at: '2026-10-01T00:00:00Z', last_message_at: null,
        last_message_preview: null, unread_count: 0, pinned_message_id: null, last_read_seq: 0, next_message_seq: 1,
        member_user_ids: ['user-1', 'user-2'], is_muted: false, my_role: 'owner',
      }],
      loadingChats: false,
      chatsLoadFailed: false,
      deleteChat: vi.fn(),
      patchChat: vi.fn(),
      identitiesById: {},
      getImRepository: async () => repository,
      subscribeAccountRevision: (event: string, handler: () => Promise<void> | void) => {
        revisionHandlers.set(event, handler)
        return () => revisionHandlers.delete(event)
      },
    },
  }
})

vi.mock('../../../../apps/desktop/src/store/auth', () => ({ useAuth: () => ({ user: authOverride.current ?? authUser, loading: false }) }))
vi.mock('../../../../apps/desktop/src/store/chatContext', () => ({ useChatStore: () => chatStore }))
vi.mock('../../../../apps/desktop/src/lib/contacts', () => ({ contactsService: contactsServiceMock }))
vi.mock('../../../../apps/desktop/src/lib/groupInvitations', () => ({ listGroupInvitations: async () => [] }))
vi.mock('../../../../apps/desktop/src/lib/identityReadAdapter', () => ({ readRequiredDisplayIdentities: async () => [] }))
vi.mock('../../../../apps/desktop/src/lib/groupJoinRequests', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../apps/desktop/src/lib/groupJoinRequests')>()),
  listManagedGroupJoinRequests: listManagedMock,
}))

import { ContactsProvider } from '../../../../apps/desktop/src/store/contacts'
import { useContactsStore, type ContactsContextValue } from '../../../../apps/desktop/src/store/contactsContext'

let store: ContactsContextValue | null = null
function Capture() {
  store = useContactsStore()
  return null
}

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })

const myGroup: ContactGroupChat = { id: 'g-1', public_id: null, kind: 'group', name: '合作方群', avatar_url: null, member_count: 2, is_muted: false, my_role: 'owner', member_user_ids: ['user-1', 'user-2'] }
const agentAsks: ManagedGroupJoinRequest = {
  id: 'r-1',
  chat_id: 'g-1',
  requester_user_id: 'agent-1',
  requester_type: 'agent',
  requested_by_user_id: 'user-2',
  message: null,
  status: 'pending',
  created_at: '2026-10-02T09:00:00Z',
  group: { id: 'g-1', name: '合作方群', avatar_url: null },
}

beforeEach(() => {
  store = null
  authOverride.current = null
  revisionHandlers.clear()
  for (const fn of Object.values(contactsServiceMock)) fn.mockReset().mockResolvedValue([])
  listManagedMock.mockReset().mockResolvedValue([])
})

describe('入群申请随 friend_requests_changed 到审批人', () => {
  it('does not reload unchanged account resources after profile hydration, but still applies revisions', async () => {
    const harness = createReactHarness()
    try {
      await harness.render(createNode(ContactsProvider, null, createNode(Capture)))
      await flush()
      const listener = revisionHandlers.get('friend_requests_changed')
      authOverride.current = { ...authUser, nickname: 'Updated profile' }
      await harness.render(createNode(ContactsProvider, null, createNode(Capture)))
      await flush()
      expect(listManagedMock).toHaveBeenCalledTimes(1)
      for (const read of Object.values(contactsServiceMock)) expect(read).toHaveBeenCalledTimes(1)
      expect(revisionHandlers.get('friend_requests_changed')).toBe(listener)

      listManagedMock.mockResolvedValue([agentAsks])
      if (!listener) throw new Error('missing request revision listener')
      await act(async () => { await listener() })
      expect(store?.groupJoinRequests.map((request) => request.id)).toEqual(['r-1'])
      expect(store?.pendingRequestCount).toBe(1)

      listManagedMock.mockRejectedValueOnce(new Error('request read failed'))
      await act(async () => { await expect(listener()).rejects.toThrow('request read failed') })
      expect(store?.groupJoinRequestsError).toBe('request read failed')
    } finally { harness.cleanup() }
  })

  it('reads the new account and refreshes after shell reactivation', async () => {
    const harness = createReactHarness()
    try {
      await harness.render(createNode(ContactsProvider, null, createNode(Capture)))
      authOverride.current = { ...authUser, id: 'user-2' }
      await harness.render(createNode(ContactsProvider, null, createNode(Capture)))
      await flush()
      expect(contactsServiceMock.getContacts).toHaveBeenLastCalledWith('user-2')
      expect(listManagedMock).toHaveBeenCalledTimes(2)
      await harness.render(createNode(ContactsProvider, { active: false }, createNode(Capture)))
      expect(listManagedMock).toHaveBeenCalledTimes(2)
      await harness.render(createNode(ContactsProvider, { active: true }, createNode(Capture)))
      await flush()
      expect(listManagedMock).toHaveBeenCalledTimes(3)
    } finally { harness.cleanup() }
  })

  it('收到这条就重读入群申请,待处理计数当场有', async () => {
    await createReactHarness().render(createNode(ContactsProvider, null, createNode(Capture)))
    await flush()
    expect(store?.groupJoinRequests).toEqual([])
    expect(store?.pendingRequestCount).toBe(0)

    // 别人的 agent 申请进我当群主的群:服务端只发这一条,客户端没有别的刷新。
    listManagedMock.mockResolvedValue([agentAsks])
    await act(async () => { await revisionHandlers.get('friend_requests_changed')?.() })
    await flush()

    expect(listManagedMock).toHaveBeenLastCalledWith([myGroup])
    expect(store?.groupJoinRequests.map((request) => request.id)).toEqual(['r-1'])
    expect(store?.pendingRequestCount).toBe(1)
  })
})
