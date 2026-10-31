import { useTranslation } from 'react-i18next'
import { Avatar } from '@/components/Avatar'
import { IconButton } from '@/components/ui/IconButton'
import { AUTOMATION_TEST_IDS } from '@/lib/automationDom'
import type { AuthUser } from '@/store/auth'

/** 「我的」的入口:「消息」「伙伴」页头左上角自己的头像(owner 10-26:「我的」不再占底栏一格,点了整屏推进来)。 */
export function PhoneMeButton({ user, onOpen }: { user: AuthUser; onOpen: () => void }) {
  const { t } = useTranslation('main')
  return (
    <IconButton size="lg" aria-label={t('shell.my')} data-testid={AUTOMATION_TEST_IDS.mobileProfileNav} onClick={onOpen}>
      <Avatar name={user.nickname} avatarUrl={user.avatarUrl} seed={user.id} size={28} />
    </IconButton>
  )
}
