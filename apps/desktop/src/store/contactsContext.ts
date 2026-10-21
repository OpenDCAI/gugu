import type { GroupInvitation } from '../lib/groupInvitations'
import type { ManagedGroupJoinRequest } from '../lib/groupJoinRequests'
import type { FriendRequestEntry } from '../lib/requestHistory'
import { createContext, useContext } from 'react'
import type { AcceptFriendRequestResult, ContactGroup, ContactGroupChat, ContactUser, FriendRequest } from '@gugu/core/shared/types/contacts'
import type { AgentLook } from '../components/agentAvatar/look'

// #2118 — 每个列表的加载态真值:空态 CTA 只能在成功的权威快照为空时出现;idle/loading 不能闪假空,
// error 必须 fail-loud(不能把基础设施失败伪装成「没有对象」)。
export type ContactsLoadStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface ContactsContextValue {
  contacts: ContactUser[]
  sharedGroupAgents: ContactUser[]
  groups: ContactGroup[]
  groupChats: ContactGroupChat[]
  /** 「新的请求」的好友 / Agent 列表:收到的与我发出的,含已处理的。 */
  friendRequests: FriendRequestEntry[]
  groupInvitations: GroupInvitation[]
  /** @@@6418 我管理的群(群主/管理员)收到的入群申请,含已处理的。 */
  groupJoinRequests: ManagedGroupJoinRequest[]
  groupJoinRequestsError: string | null
  pendingRequestCount: number
  requestsStatus: ContactsLoadStatus
  requestsError: string | null
  sentRequests: FriendRequest[]
  loadingContacts: boolean
  loadingGroups: boolean
  // #2118 — contacts / groupChats 各自的三态(注意 loadingGroups 是联系人标签 groups,≠ 群聊 groupChats)。
  contactsStatus: ContactsLoadStatus
  groupChatsStatus: ContactsLoadStatus
  searchResults: ContactUser[]
  isSearching: boolean
  searchUsers: (query: string) => Promise<void>
  clearSearch: () => void
  sendRequest: (targetUserId: string, message?: string | null) => Promise<void>
  acceptRequest: (requestId: string) => Promise<AcceptFriendRequestResult>
  rejectRequest: (requestId: string) => Promise<void>
  refreshContacts: () => Promise<void>
  refreshGroups: () => Promise<void>
  refreshRequests: () => Promise<void>
  refreshGroupJoinRequests: () => Promise<void>
  createGroup: (name: string) => Promise<string | null>
  renameGroup: (groupId: string, name: string) => Promise<void>
  deleteGroup: (groupId: string) => Promise<void>
  updateGroupMembers: (groupId: string, contactIds: string[]) => Promise<void>
  updateContactAlias: (contactId: string, alias: string) => Promise<void>
  setAgentPublic: (agentId: string, agentPublic: boolean) => Promise<void>
  setAgentDesiredStatus: (agentId: string, desiredStatus: 'online' | 'offline') => Promise<void>
  renameAgent: (agentId: string, name: string) => Promise<void>
  updateAgentProfile: (agentId: string, fields: { name?: string; bio?: string; avatar?: string | null }) => Promise<void>
  uploadAgentAvatar: (agentId: string, file: File, profile?: { name?: string; bio?: string }) => Promise<void>
  /** 存这只 agent 的形象(颜色 + 休息表情):写进它的头像字段,换掉之前的形象或照片。 */
  setAgentLook: (agentId: string, look: AgentLook) => Promise<void>
  removeOwnedAgent: (agentId: string) => Promise<void>
  removeContact: (contactId: string) => Promise<void>
  getCommonGroupChats: (contactId: string) => Promise<ContactGroupChat[]>
}

export const ContactsContext = createContext<ContactsContextValue>({
  contacts: [],
  sharedGroupAgents: [],
  groups: [],
  groupChats: [],
  friendRequests: [],
  groupInvitations: [],
  groupJoinRequests: [],
  groupJoinRequestsError: null,
  pendingRequestCount: 0,
  requestsStatus: 'idle',
  requestsError: null,
  sentRequests: [],
  loadingContacts: false,
  loadingGroups: false,
  contactsStatus: 'idle',
  groupChatsStatus: 'idle',
  searchResults: [],
  isSearching: false,
  searchUsers: async () => {},
  clearSearch: () => {},
  sendRequest: async () => {},
  acceptRequest: async () => ({ chatId: null, name: null, kind: null, created: false, member_count: null }),
  rejectRequest: async () => {},
  refreshContacts: async () => {},
  refreshGroups: async () => {},
  refreshRequests: async () => {},
  refreshGroupJoinRequests: async () => {},
  createGroup: async () => null,
  renameGroup: async () => {},
  deleteGroup: async () => {},
  updateGroupMembers: async () => {},
  updateContactAlias: async () => {},
  setAgentPublic: async () => {},
  setAgentDesiredStatus: async () => {},
  renameAgent: async () => {},
  updateAgentProfile: async () => {},
  uploadAgentAvatar: async () => {},
  setAgentLook: async () => {},
  removeOwnedAgent: async () => {},
  removeContact: async () => {},
  getCommonGroupChats: async () => [],
})

export function useContactsStore(): ContactsContextValue {
  return useContext(ContactsContext)
}
