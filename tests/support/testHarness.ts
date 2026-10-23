import { act, createElement, type ElementType, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { vi } from 'vitest'
import type { ChatItem, Device, MessageItem, NotificationLevel } from '@gugu/core/shared/types/chat'
import type { ContactUser } from '@gugu/core/shared/types/contacts'
import { ToastContext, type ToastContextValue } from '../../apps/desktop/src/components/toastContext'
import { AuthContext, type AuthUser } from '../../apps/desktop/src/store/auth'
import { ChatStoreProvider } from '../../apps/desktop/src/store/chatContext'
import type { ChatContextValue } from '../../apps/desktop/src/store/chatContext'
import { chatWindowStub } from './chatWindowStub'
import { deriveThreadScope } from '../../apps/desktop/src/store/threadScope'
import { ContactsContext } from '../../apps/desktop/src/store/contactsContext'
import type { ContactsContextValue } from '../../apps/desktop/src/store/contactsContext'
import type { DisplayIdentity } from '../../apps/desktop/src/lib/displayIdentity'

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

export function createReactHarness() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)

  return {
    container,
    async render(node: ReactNode) {
      await act(async () => {
        root.render(node)
      })
    },
    cleanup() {
      act(() => {
        root.unmount()
      })
      container.remove()
      vi.restoreAllMocks()
    },
  }
}

function authUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    // Shared neutral signed-in user used by component tests that do not care about identity.
    id: 'user-1',
    email: 'user@example.com',
    nickname: 'User',
    avatarUrl: 'https://db.example/storage/v1/object/public/avatars/fixture-owner.fixture-agent.png',
    ...overrides,
  }
}

export async function renderWithAppProviders(
  harness: ReturnType<typeof createReactHarness>,
  node: ReactNode,
  options: {
    auth?: Partial<AuthUser> | null
    chat?: Partial<ChatContextValue>
    contacts?: Partial<ContactsContextValue>
    toast?: ToastContextValue['toast']
  } = {},
) {
  let tree = node
  tree = createElement(ChatStoreProvider, { value: chatStore({ ...chatWindowStub(options.auth?.id), ...options.chat }) }, tree)
  if (options.contacts) {
    tree = createElement(ContactsContext.Provider, { value: contactsStore(options.contacts) }, tree)
  }
  tree = createElement(
    AuthContext.Provider,
    {
      value: {
        user: options.auth === null ? null : authUser(options.auth),
        loading: false,
        status: options.auth === null ? 'anonymous' : 'authenticated',
        updateUser: vi.fn(),
        logout: vi.fn(async () => ({ success: true })),
      },
    },
    createElement(
      ToastContext.Provider,
      { value: { toast: options.toast ?? vi.fn() } },
      tree,
    ),
  )
  await harness.render(tree)
}

export async function typeInto(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

export async function selectValue(select: HTMLSelectElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set
    setter?.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await Promise.resolve()
  })
}

export async function clickElement(element: HTMLElement) {
  await act(async () => {
    element.click()
    await Promise.resolve()
  })
}

export async function fireContextMenu(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    await Promise.resolve()
  })
}

// @@@1614 @@@1802 — flaky 修复统一件:固定延时赌异步就绪是全量并发下偶发假红的根源,一律改条件等待。
// timeout 取宽(只在真失败时才等满,慢环境兜底),interval 取密(成功路径几乎零额外延迟)。
// @@@1765 review — 共享 deferred:手动控制 promise 时序(并发/去重/挂死场景)。原先
// ChatProviderRealtime.test 与 runtimeBridgeImplStateMachine.test 各养一份,签名已开始漂移。
export function deferred<T = unknown>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve
    reject = innerReject
  })
  return { promise, resolve, reject }
}

export const WAIT = { timeout: 5000, interval: 20 }

export async function waitForCondition(cond: () => boolean, msg: string): Promise<void> {
  await vi.waitFor(() => {
    if (!cond()) throw new Error(msg)
  }, WAIT)
}

export function chat(overrides: Partial<ChatItem>): ChatItem {
  return {
    id: 'chat-1',
    kind: 'dm',
    status: 'active',
    avatar: 'https://db.example/storage/v1/object/public/avatars/fixture-owner.fixture-agent.png',
    name: 'Chat One',
    created_at: '2026-01-01T00:00:00.000Z',
    last_message_at: null,
    last_message_preview: null,
    unread_count: 0,
    pinned_message_id: null,
    last_read_seq: 0,
    next_message_seq: 1,
    notification_level: 'all' satisfies NotificationLevel,
    is_muted: false,
    ...overrides,
  }
}

export function displayIdentity(id: string, overrides: Partial<DisplayIdentity> = {}): DisplayIdentity {
  return {
    id, type: 'human', display_name: id, avatar: null, gugu_number: null, bio: null,
    owner_user_id: null, agent_public: null, desired_status: null, device_id: null,
    category: null, is_official: null, local_path: null, created_at: null, updated_at: null,
    ...overrides,
  }
}

export function message(overrides: Partial<MessageItem> = {}): MessageItem {
  return {
    id: 'message-1',
    chat_id: 'chat-1',
    sender_user_id: 'peer-1',
    to_user_ids: null,
    seq: 1,
    content: 'hello',
    content_type: 'text',
    reply_to_message_id: null,
    retracted_at: null,
    created_at: '2026-05-24T00:00:00.000Z',
    reactions: [],
    is_mine: false,
    delivered: true,
    delivery_status: null,
    local_send_state: null,
    ...overrides,
  }
}

export function device(
  deviceId: string,
  terminals: Device['capabilities']['terminals'],
  overrides: Partial<Device> = {},
): Device {
  return {
    device_id: deviceId,
    label: deviceId,
    hostname: `${deviceId}.local`,
    platform: 'darwin',
    status: 'online',
    last_seen_at: '2026-05-23T00:00:00.000Z',
    is_online: true,
    capabilities: { terminals, runtimes: ['codex'] },
    ...overrides,
  }
}

export function chatStore(overrides: Partial<ChatContextValue> = {}): ChatContextValue {
  const merged: ChatContextValue = {
    ...chatWindowStub(),
    getImRepository: async () => { throw new Error('test repository not configured') },
    subscribeAccountRevision: () => () => undefined,
    identitiesById: {},
    chats: [],
    activeChatId: null,
    activeChat: null,
    messages: [],
    loadingChats: false,
    chatsLoadFailed: false,
    chatsRead: true,
    loadingMessages: false,
    messagesError: null,
    hasMoreOlder: false,
    loadingOlder: false,
    loadNewerMessages: async () => {},
    loadMessageAnchor: async () => {},
    markMessageVisible: () => {},
    returnToLatestMessages: async () => {},
    memberReadSeqs: {},
    drafts: {},
    draftMentions: {},
    draftAttachments: {},
    draftRefs: {},
    activeThreadRootId: null,
    threadMessages: [],
    loadingThread: false,
    threadScope: { rootId: null, isOpen: false, messages: [], loading: false },
    openThread: vi.fn(),
    openUnreadChat: vi.fn(async () => {}),
    jumpToUnreadEntry: vi.fn(async () => {}),
    setActiveChatId: vi.fn(),
    sendMessage: vi.fn(async () => undefined),
    sendMessageToChat: vi.fn(async () => undefined),
    retrySend: vi.fn(),
    discardSend: vi.fn(),
    toggleReaction: vi.fn(async () => {}),
    refreshChats: vi.fn(async () => {}),
    refreshMessages: vi.fn(async () => {}),
    loadOlderMessages: vi.fn(async () => {}),
    setFollowingTail: vi.fn(),
    createGroupChat: vi.fn(async () => 'group-chat-1'),
    clearMessages: vi.fn(async () => {}),
    removeMessage: vi.fn(),
    deleteMessage: vi.fn(async () => {}),
    appendMessage: vi.fn(),
    upsertChat: vi.fn(),
    pinChat: vi.fn(),
    deleteChat: vi.fn(async () => {}),
    leaveGroup: vi.fn(async () => {}),
    markUnread: vi.fn(),
    setChatNotificationLevel: vi.fn(),
    patchChat: vi.fn(),
    setDraft: vi.fn(),
    setDraftMentions: vi.fn(),
    setDraftAttachments: vi.fn(),
    setDraftRefs: vi.fn(),
    ...overrides,
  }
  // @@@1577 M3 — keep threadScope consistent with (possibly overridden) granular fields unless a test
  // pins threadScope explicitly, so component/hook consumers reading the scope see a coherent value.
  return {
    ...merged,
    threadScope:
      overrides.threadScope ??
      deriveThreadScope({
        rootId: merged.activeThreadRootId,
        messages: merged.messages,
        threadMessages: merged.threadMessages,
        loadingThread: merged.loadingThread,
        loadingMessages: merged.loadingMessages,
      }),
  }
}

export function contact(overrides: Partial<ContactUser>): ContactUser {
  return {
    id: 'contact-1',
    display_name: 'Contact One',
    avatar: 'https://db.example/storage/v1/object/public/avatars/fixture-owner.fixture-agent.png',
    email: 'contact@example.com',
    bio: null,
    type: 'human',
    ...overrides,
  }
}

export function contactsStore(overrides: Partial<ContactsContextValue> = {}): ContactsContextValue {
  return {
    contacts: [],
    sharedGroupAgents: [],
    groups: [],
    groupChats: [],
    friendRequests: [],
    groupInvitations: [],
    groupJoinRequests: [],
    groupJoinRequestsError: null,
    pendingRequestCount: [
      ...(overrides.friendRequests ?? []).filter((entry) => entry.direction === 'received').map((entry) => entry.request),
      ...(overrides.groupInvitations ?? []),
      ...(overrides.groupJoinRequests ?? []),
    ].filter((request) => request.status === 'pending').length,
    requestsStatus: 'ready',
    requestsError: null,
    sentRequests: [],
    loadingContacts: false,
    loadingGroups: false,
    contactsStatus: 'ready',
    groupChatsStatus: 'ready',
    searchResults: [],
    isSearching: false,
    searchUsers: vi.fn(async () => {}),
    clearSearch: vi.fn(),
    sendRequest: vi.fn(async () => {}),
    acceptRequest: vi.fn(async () => ({ chatId: null, name: null, kind: null, created: false, member_count: null })),
    rejectRequest: vi.fn(async () => {}),
    refreshContacts: vi.fn(async () => {}),
    refreshGroups: vi.fn(async () => {}),
    refreshRequests: vi.fn(async () => {}),
    refreshGroupJoinRequests: vi.fn(async () => {}),
    createGroup: vi.fn(async () => null),
    renameGroup: vi.fn(async () => {}),
    deleteGroup: vi.fn(async () => {}),
    updateGroupMembers: vi.fn(async () => {}),
    updateContactAlias: vi.fn(async () => {}),
    setAgentPublic: vi.fn(async () => {}),
    setAgentDesiredStatus: vi.fn(async () => {}),
    renameAgent: vi.fn(async () => {}),
    updateAgentProfile: vi.fn(async () => {}),
    uploadAgentAvatar: vi.fn(async () => {}),
    setAgentLook: vi.fn(async () => {}),
    removeOwnedAgent: vi.fn(async () => {}),
    removeContact: vi.fn(async () => {}),
    getCommonGroupChats: vi.fn(async () => []),
    ...overrides,
  }
}

export function createNode(type: ElementType, props?: Record<string, unknown> | null, ...children: ReactNode[]) {
  return createElement(type, props, ...children)
}
