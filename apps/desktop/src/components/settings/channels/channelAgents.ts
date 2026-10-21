import { useMemo } from 'react'
import type { ContactUser } from '@gugu/core/shared/types/contacts'
import { useAuth } from '../../../store/auth'
import { useContactsStore } from '../../../store/contactsContext'

/** 自己名下的 agent;聊天渠道只能对接自己的(管家那边也验)。 */
export function useOwnedAgents(): ContactUser[] {
  const { user } = useAuth()
  const { contacts } = useContactsStore()
  return useMemo(
    () => contacts.filter((contact) => contact.type === 'agent' && user?.id && contact.owner_user_id === user.id),
    [contacts, user?.id],
  )
}
