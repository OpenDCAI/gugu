import { useTranslation } from 'react-i18next'
import { useAuth } from '../store/auth'

export function AgentOwnerLabel({ ownerUserId, ownerDisplayName }: {
  ownerUserId?: string | null
  ownerDisplayName?: string | null
}) {
  const { user } = useAuth()
  const { t } = useTranslation('contacts')
  if (ownerUserId && ownerUserId === user?.id) return <>{t('profile.myAgentLabel')}</>
  return <>{ownerDisplayName ? t('profile.agentOwnerLabel', { owner: ownerDisplayName }) : t('profile.agentOwnerUnavailable')}</>
}
