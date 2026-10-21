import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { PublicGroupJoinResult } from '@gugu/core/shared/types/contacts'
import type { GroupJoinMode } from '@gugu/core/shared/types/chat'
import { contactsService, GroupJoinRefusedError } from './contacts'
import { rendererLogger } from './log'
import { useChatStore } from '../store/chatContext'

const groupInviteLog = rendererLogger('contacts/group-invite')
export interface GroupInviteJoinGroup {
  public_id: number
  join_mode: GroupJoinMode
  is_member: boolean
  join_request_status: 'pending' | 'accepted' | 'rejected' | null
  invite_link_enabled?: boolean
}
export type GroupInviteJoinUnavailableCode = 'already_joined' | 'pending' | 'invite_only' | 'invite_link_closed' | 'missing_token' | 'joining'
export class GroupInviteJoinUnavailableError extends Error {
  constructor(public readonly code: GroupInviteJoinUnavailableCode) {
    super(code)
    this.name = 'GroupInviteJoinUnavailableError'
  }
}
export class GroupInviteJoinError extends Error {
  constructor(message: string, public readonly originalError: unknown) {
    super(message)
    this.name = 'GroupInviteJoinError'
  }
}
export interface GroupInviteJoinState {
  joining: boolean
  joinError: string | null
  join: (group: GroupInviteJoinGroup, joinToken: string | null | undefined) => Promise<PublicGroupJoinResult>
  reset: () => void
}
const unavailableErrorKeys: Record<GroupInviteJoinUnavailableCode, string> = { already_joined: 'groupInvite.joined', pending: 'groupInvite.pendingApproval', invite_only: 'groupInvite.inviteOnlyError', invite_link_closed: 'groupInvite.inviteLinkClosedError', missing_token: 'groupInvite.invalidLink', joining: 'groupInvite.joining' }
export async function joinGroupByInvite(group: GroupInviteJoinGroup, rawJoinToken: string | null | undefined): Promise<PublicGroupJoinResult> {
  const joinToken = rawJoinToken?.trim()
  if (group.is_member) throw new GroupInviteJoinUnavailableError('already_joined')
  if (group.join_request_status === 'pending') throw new GroupInviteJoinUnavailableError('pending')
  if (group.invite_link_enabled === false) throw new GroupInviteJoinUnavailableError('invite_link_closed')
  if (group.join_mode === 'invite_only') throw new GroupInviteJoinUnavailableError('invite_only')
  if (!joinToken) throw new GroupInviteJoinUnavailableError('missing_token')
  if (group.join_mode === 'approval') return contactsService.requestGroupJoin(group.public_id, joinToken)
  try {
    return await contactsService.joinPublicGroup(group.public_id, joinToken)
  } catch (error) {
    // 快照说 open,服务端说这群此刻仅限邀请 / 关了自助入群:与上面的前置拒绝同一种结果。
    if (error instanceof GroupJoinRefusedError) throw new GroupInviteJoinUnavailableError(error.reason)
    throw error
  }
}
export function useGroupInviteJoin(): GroupInviteJoinState {
  const { t } = useTranslation('contacts')
  const { refreshChats } = useChatStore('refreshChats')
  const [joining, setJoining] = useState(false)
  const [joinError, setJoinError] = useState<string | null>(null)
  const joiningRef = useRef(false)
  const errorMessage = useCallback((error: unknown) => {
    if (error instanceof GroupInviteJoinUnavailableError) {
      return t(unavailableErrorKeys[error.code])
    }
    return error instanceof Error && error.message.trim()
      ? t('groupInvite.joinFailedWithReason', { error: error.message })
      : t('groupInvite.joinFailed')
  }, [t])
  const join = useCallback(async (group: GroupInviteJoinGroup, joinToken: string | null | undefined) => {
    if (joiningRef.current) throw new GroupInviteJoinUnavailableError('joining')
    joiningRef.current = true
    setJoining(true)
    setJoinError(null)
    try {
      const result = await joinGroupByInvite(group, joinToken)
      if (result.status === 'joined') await refreshChats()
      return result
    } catch (error) {
      groupInviteLog.error({ error: error instanceof Error ? error.message : String(error) }, 'join failed')
      const message = errorMessage(error)
      setJoinError(message)
      throw new GroupInviteJoinError(message, error)
    } finally {
      joiningRef.current = false
      setJoining(false)
    }
  }, [errorMessage, refreshChats])
  const reset = useCallback(() => setJoinError(null), [])
  return { joining, joinError, join, reset }
}
