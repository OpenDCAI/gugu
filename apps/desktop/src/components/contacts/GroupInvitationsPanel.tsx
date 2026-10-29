import { useGroupDisplayName } from '../../hooks/useGroupDisplayName'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useContactsStore } from '../../store/contactsContext'
import { useChatStore } from '../../store/chatContext'
import { decideGroupInvitation, type GroupInvitation } from '../../lib/groupInvitations'
import { rendererLogger } from '../../lib/log'
import { messageForUser } from '../../lib/userFacingError'
import { Avatar } from '../Avatar'
import { Button } from '../ui/Button'

const invitationLog = rendererLogger('contacts/group-invitations')

function GroupInvitationRow({ invitation }: { invitation: GroupInvitation }) {
  const { t } = useTranslation('contacts')
  const { refreshRequests } = useContactsStore()
  const groupName = useGroupDisplayName({ id: invitation.chat_id, name: invitation.group_name })
  const { refreshChats } = useChatStore('refreshChats')
  const busyRef = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function decide(accept: boolean) {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      await decideGroupInvitation(invitation.id, accept)
      if (accept) {
        await refreshChats()
      }
      await refreshRequests()
    } catch (cause) {
      invitationLog.error({ invitationId: invitation.id, error: String(cause) }, 'group invitation decision failed')
      setError(cause instanceof Error && (cause.message === 'Group member limit reached' || cause.message === 'member_limit_reached')
        ? t('groupInvitations.full')
        : messageForUser(cause))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <div className="mx-3 border-b border-[var(--border-subtle)] px-1 py-3" data-testid="group-invitation" data-invitation-id={invitation.id}>
      <div className="flex items-start gap-3">
        <Avatar name={invitation.inviter_name} seed={invitation.inviter_user_id} isAgent={invitation.inviter_type === 'agent'} size="md" />
        <div className="min-w-0 flex-1 text-sm">
          <div className="font-medium text-[var(--text-primary)]">{t(invitation.inviter_type === 'agent' ? 'groupInvitations.invitedBy' : 'groupInvitations.invitedByHuman', { inviter: invitation.inviter_name, owner: invitation.inviter_owner_name, group: groupName })}</div>
          {invitation.invitee_type === 'agent' && <div className="mt-1 text-[var(--text-secondary)]">{t('groupInvitations.agent', { name: invitation.invitee_name })}</div>}
          <p className="my-2 whitespace-pre-wrap break-words text-[var(--text-secondary)]">{invitation.message}</p>
          {invitation.status === 'pending' ? <>
            <div className="text-[var(--text-secondary)]">{t(invitation.invitee_type === 'human' ? 'groupInvitations.humanJoins' : invitation.owner_will_join ? 'groupInvitations.ownerJoins' : 'groupInvitations.agentJoins')}</div>
            <div className="mt-3 flex gap-2">
              <Button size="sm" variant="primary" disabled={busy} onClick={() => void decide(true)} data-testid="group-invitation-accept">{t('groupInvitations.accept')}</Button>
              <Button size="sm" disabled={busy} onClick={() => void decide(false)} data-testid="group-invitation-reject">{t('groupInvitations.reject')}</Button>
            </div>
          </> : <div className="text-[var(--text-tertiary)]">{t(invitation.status === 'accepted' ? 'groupJoinRequests.statusAccepted' : 'groupJoinRequests.statusRejected')}</div>}
          {error && <div role="alert" className="mt-2 text-[var(--danger-fg)]">{error}</div>}
        </div>
      </div>
    </div>
  )
}

export function GroupInvitationsPanel() {
  const { t } = useTranslation('contacts')
  const { groupInvitations, requestsStatus } = useContactsStore()
  if (requestsStatus === 'idle' || requestsStatus === 'loading') return <p role="status" className="p-4 text-sm">{t('common.loading')}</p>
  if (!groupInvitations.length) {
    return requestsStatus === 'ready' ? <p className="px-4 py-12 text-center text-sm text-[var(--text-secondary)]">{t('groupInvitations.empty')}</p> : null
  }
  return <>{groupInvitations.map((invitation) => <GroupInvitationRow key={invitation.id} invitation={invitation} />)}</>
}
