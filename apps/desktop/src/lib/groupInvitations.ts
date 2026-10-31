import { currentGroupAdmin } from './groupAdmin'
import { pendingFirst } from './requestHistory'

export interface GroupInvitation {
  id: string
  chat_id: string
  group_name: string | null
  inviter_user_id: string
  inviter_type: 'human' | 'agent'
  inviter_name: string
  inviter_owner_name: string
  invitee_user_id: string
  invitee_name: string
  invitee_type: 'human' | 'agent'
  decision_user_id: string
  owner_will_join: boolean
  message: string
  status: 'pending' | 'accepted' | 'rejected'
  created_at: string
}

export async function listGroupInvitations(): Promise<GroupInvitation[]> {
  const data = await (await currentGroupAdmin()).invitations(false)
  return (data as unknown as GroupInvitation[]).sort(pendingFirst)
}

export async function decideGroupInvitation(invitationId: string, accept: boolean): Promise<void> {
  await (await currentGroupAdmin()).decideInvitation(invitationId, accept)
}
