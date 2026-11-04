// @vitest-environment jsdom
// #2118 — ContactsProvider 加载三态转换回归(provider 级,非渲染 harness 注入)。
// 锁死 019 复审的 blocking:ready 之后 refresh 失败绝不停留 ready(否则空旧快照冒充权威空、显误导 CTA)。
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
    },
    refreshChatsMock: vi.fn(),
    chatState: { chatsLoadFailed: false },
  }
})

vi.mock('../../../../apps/desktop/src/store/auth', () => ({ useAuth: () => ({ user: authUser, loading: false }) }))
vi.mock('../../../../apps/desktop/src/store/chatContext', () => ({
  useChatStore: () => ({
    refreshChats: refreshChatsMock,
    chats: [],
    loadingChats: false,
    chatsLoadFailed: chatState.chatsLoadFailed,
    deleteChat: vi.fn(),
    patchChat: vi.fn(),
    identitiesById,
    getImRepository: getImRepositoryMock,
    subscribeAccountRevision: () => () => undefined,
  }),
}))
vi.mock('../../../../apps/desktop/src/lib/contacts', () => ({ contactsService: contactsServiceMock }))
const { readRequiredDisplayIdentitiesMock } = vi.hoisted(() => ({ readRequiredDisplayIdentitiesMock: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/identityReadAdapter', () => ({ readRequiredDisplayIdentities: readRequiredDisplayIdentitiesMock }))
// The private identity_removed channel is not under test here; keep it off the real realtime socket.
vi.mock('../../../../apps/desktop/src/hooks/useIdentityLifecycle', () => ({ useIdentityLifecycle: vi.fn() }))

import { ContactsProvider } from '../../../../apps/desktop/src/store/contacts'
import { useContactsStore, type ContactsContextValue } from '../../../../apps/desktop/src/store/contactsContext'
import { UI_EVENTS } from '../../../../apps/desktop/src/lib/uiEvents'

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

const alice: ContactUser = { id: 'c-1', display_name: 'Alice', avatar: '', email: null, bio: null, type: 'human' }

beforeEach(() => {
  store = null
  for (const id of Object.keys(identitiesById)) delete identitiesById[id]
  putIdentitiesMock.mockClear()
  getImRepositoryMock.mockClear()
  for (const fn of Object.values(contactsServiceMock)) (fn as ReturnType<typeof vi.fn>).mockReset()
  refreshChatsMock.mockReset().mockResolvedValue(undefined)
  contactsServiceMock.getContacts.mockResolvedValue([])
  contactsServiceMock.getContactGroups.mockResolvedValue([])
  chatState.chatsLoadFailed = false
  contactsServiceMock.getReceivedRequests.mockResolvedValue([])
  contactsServiceMock.getSentRequests.mockResolvedValue([])
  contactsServiceMock.updateContactAlias.mockResolvedValue(undefined)
  contactsServiceMock.removeOwnedAgent.mockResolvedValue(undefined)
  readRequiredDisplayIdentitiesMock.mockReset().mockImplementation(async (ids: string[]) =>
    ids.map((id) => ({ id, display_name: id, avatar: null, bio: null, type: 'agent', removed_at: '2026-10-31T00:00:00Z' })))
})

describe('#2118 ContactsProvider 加载三态转换', () => {
  it('首次成功空集合 → refresh reject → contactsStatus=error(绝不停留 ready 冒充空)', async () => {
    contactsServiceMock.getContacts.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('net'))
    await renderProvider()
    expect(store?.contactsStatus).toBe('ready')
    expect(store?.contacts).toEqual([])
    await act(async () => { await store!.refreshContacts() })
    await flushReact()
    expect(store?.contactsStatus).toBe('error') // ← 不再是 ready → UI 显失败/重试,不显空态 CTA
  })

  it('失败时旧列表数据不被清空(ready 非空 → refresh reject → 保留旧快照 + error)', async () => {
    contactsServiceMock.getContacts.mockResolvedValueOnce([alice]).mockRejectedValueOnce(new Error('net'))
    await renderProvider()
    expect(store?.contacts).toEqual([alice])
    expect(store?.contactsStatus).toBe('ready')
    await act(async () => { await store!.refreshContacts() })
    await flushReact()
    expect(store?.contacts).toEqual([alice]) // 旧数据保留,不清空
    expect(store?.contactsStatus).toBe('error')
  })

  it('retry 成功 → 回到 ready 并展示新权威快照', async () => {
    contactsServiceMock.getContacts
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('net'))
      .mockResolvedValueOnce([alice])
    await renderProvider()
    await act(async () => { await store!.refreshContacts() })
    await flushReact()
    expect(store?.contactsStatus).toBe('error')
    await act(async () => { await store!.refreshContacts() }) // retry
    await flushReact()
    expect(store?.contactsStatus).toBe('ready')
    expect(store?.contacts).toEqual([alice]) // 新权威快照
  })

  it('保存或清除通讯录备注后刷新会话标题 (#2906)', async () => {
    contactsServiceMock.getContacts.mockResolvedValueOnce([{ ...alice, alias: null }])
    const harness = await renderProvider()

    try {
      await act(async () => { await store!.updateContactAlias(alice.id, '  Alice 备注  ') })
      expect(contactsServiceMock.updateContactAlias).toHaveBeenLastCalledWith(
        authUser.id,
        alice.id,
        '  Alice 备注  ',
      )
      expect(store?.contacts[0]?.alias).toBe('Alice 备注')

      await act(async () => { await store!.updateContactAlias(alice.id, '   ') })
      expect(store?.contacts[0]?.alias).toBeNull()
      expect(refreshChatsMock).toHaveBeenCalledTimes(2)
    } finally {
      harness.cleanup()
    }
  })

  it('群来自会话投影:投影读失败 → status=error,空着不冒充「没有群」', async () => {
    chatState.chatsLoadFailed = true
    await renderProvider()
    expect(store?.groupChatsStatus).toBe('error') // fail-loud,不是 ready 空
  })

  // 3d93c66cf replaced the local optimistic drop with an awaited authoritative re-read: the archive action
  // resolves only once contacts come from active_friendships/active_users without the archived Agent.
  it('归档 Agent 的动作在权威重读之后才结束,结束时它已不在通讯录里', async () => {
    const agent: ContactUser = {
      id: 'agent-1',
      display_name: 'Deploy Bot',
      avatar: null,
      bio: null,
      type: 'agent',
      owner_user_id: authUser.id,
    }
    let resolveReload!: (contacts: ContactUser[]) => void
    const reload = new Promise<ContactUser[]>((resolve) => {
      resolveReload = resolve
    })
    contactsServiceMock.getContacts.mockResolvedValueOnce([agent]).mockReturnValueOnce(reload)
    const harness = await renderProvider()
    const invalidated: unknown[] = []
    const onInvalidated = (event: Event) => invalidated.push((event as CustomEvent).detail)
    window.addEventListener(UI_EVENTS.identityInvalidated, onInvalidated)

    try {
      expect(store?.contacts.map((contact) => contact.id)).toEqual(['agent-1'])
      let settled = false
      let removal!: Promise<void>
      await act(async () => {
        removal = store!.removeOwnedAgent(agent.id, { removeSocialIdentity: true }).then(() => { settled = true })
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(contactsServiceMock.removeOwnedAgent).toHaveBeenCalledExactlyOnceWith('agent-1', { removeSocialIdentity: true })
      expect(readRequiredDisplayIdentitiesMock).toHaveBeenCalledWith(['agent-1'])
      expect(invalidated).toEqual([{ id: 'agent-1' }])
      expect(settled).toBe(false)

      resolveReload([])
      await act(async () => { await removal })
      expect(settled).toBe(true)
      expect(store?.contacts).toEqual([])
      expect(refreshChatsMock).toHaveBeenCalledWith(expect.objectContaining({ preserveMissingActive: false, throwOnError: true }))
    } finally {
      window.removeEventListener(UI_EVENTS.identityInvalidated, onInvalidated)
      harness.cleanup()
    }
  })
})

vi.mock('../../../../apps/desktop/src/lib/groupInvitations', () => ({ listGroupInvitations: vi.fn(async () => []) }))
