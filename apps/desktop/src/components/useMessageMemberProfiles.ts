import { useMemo } from 'react'
import type { AgentDisplayStatus, GroupCollabSnapshot } from '@gugu/core/shared/types/chat'
import { useChatStore } from '../store/chatContext'
import { useContactsStore } from '../store/contactsContext'
import { useAuth } from '../store/auth'
import { useStructurallyShared } from '../hooks/useStructurallyShared'
import type { useShownAgentStatus } from './chat/useAgentsOnCloudComputer'
import type { MemberProfileCardModel } from './MemberProfileCard'
import { buildMemberProfileMap, toIdentityProfile } from './memberProfileModels'

/**
 * The member profile cards behind the open conversation's messages: room members (including former ones who still
 * have messages, #5610) named with the viewer's contact aliases, or the two sides of a direct chat.
 * Every new message or row patch rebuilds the table; unchanged content keeps its reference so bubble memos hold.
 */
export function useMessageMemberProfiles(
  isRoomChatSurface: boolean,
  groupCollabSnapshot: GroupCollabSnapshot,
  groupAgentStatuses: Record<string, AgentDisplayStatus>,
  shownAgent: ReturnType<typeof useShownAgentStatus>,
): Record<string, MemberProfileCardModel> {
  const { identitiesById, activeChat, messages } = useChatStore('identitiesById', 'activeChat', 'messages')
  const { contacts } = useContactsStore()
  const { user } = useAuth()
  const peerIdentity = identitiesById[activeChat?.peer_user_id ?? '']
  return useStructurallyShared(useMemo((): Record<string, MemberProfileCardModel> => {
    if (isRoomChatSurface) {
      const aliases = Object.fromEntries(contacts.map((contact) => [contact.id, contact.alias]))
      return buildMemberProfileMap(groupCollabSnapshot, identitiesById, shownAgent.statuses(groupAgentStatuses), messages.map((message) => message.sender_user_id), aliases)
    }
    if (!activeChat || !user) return {}
    const profiles: Record<string, MemberProfileCardModel> = {}
    const ownIdentity = identitiesById[user.id]
    if (ownIdentity) profiles[user.id] = toIdentityProfile(ownIdentity)
    const peerProfile = activeChat.peer_user_id && peerIdentity ? toIdentityProfile(peerIdentity, 'member', 'direct') : null
    if (peerProfile) profiles[peerProfile.id] = peerProfile
    return profiles
  }, [activeChat, contacts, groupAgentStatuses, groupCollabSnapshot, identitiesById, isRoomChatSurface, messages, peerIdentity, shownAgent, user]))
}
