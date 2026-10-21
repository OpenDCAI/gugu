import { chatDb } from './supabase'
import { pendingFirst } from './requestHistory'

export interface GroupInvitation {
  id: string
  chat_id: string
  group_name: string | null
  inviter_agent_user_id: string
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
  const { data, error } = await chatDb.rpc('list_agent_group_invitations', { p_include_decided: true })
  if (error) throw new Error(error.message)
  if (!Array.isArray(data)) throw new Error('Group invitations response is not a list')
  return (data as GroupInvitation[]).sort(pendingFirst)
}

export async function decideGroupInvitation(invitationId: string, accept: boolean): Promise<void> {
  const { data, error } = await chatDb.rpc('decide_agent_group_invitation', {
    p_invitation_id: invitationId,
    p_accept: accept,
  })
  if (error) throw new Error(error.message)
  const expected = accept ? 'accepted' : 'rejected'
  if (!data || typeof data !== 'object' || ((data as { status?: string }).status !== expected || (data as { invitation_id?: string }).invitation_id !== invitationId)) {
    throw new Error('Group invitation decision was not confirmed')
  }
}
