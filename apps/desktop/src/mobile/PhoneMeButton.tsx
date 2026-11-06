import { useTranslation } from 'react-i18next'
import { Avatar } from '@/components/Avatar'
import { IconButton } from '@/components/ui/IconButton'
import { AUTOMATION_TEST_IDS } from '@/lib/automationDom'
import { useAvatarIdentity } from '@/lib/avatarIdentity'
import type { AuthUser } from '@/store/auth'

/** 「我的」的入口:「消息」「伙伴」页头左上角自己的头像(owner 10-26:「我的」不再占底栏一格,点了整屏推进来)。 */
export function PhoneMeButton({ user, onOpen }: { user: AuthUser; onOpen: () => void }) {
  const { t } = useTranslation('main')
  // Until the network profile lands (identityPending), my own row in the local identity directory is who I am on screen.
  // The signed-in account is a person: its face never waits for the directory to say so.
  const local = useAvatarIdentity(user.identityPending ? user.id : '')
  const name = user.identityPending && local ? local.display_name : user.nickname
  const avatarUrl = user.identityPending && local ? local.avatar ?? undefined : user.avatarUrl
  return (
    <IconButton size="lg" aria-label={t('shell.my')} data-testid={AUTOMATION_TEST_IDS.mobileProfileNav} onClick={onOpen}>
      <Avatar name={name} avatarUrl={avatarUrl} seed={user.id} isAgent={false} size={28} />
    </IconButton>
  )
}
