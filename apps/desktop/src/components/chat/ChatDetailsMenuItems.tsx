import { useTranslation } from 'react-i18next'
import { Users } from '@/lib/icons'
import { AUTOMATION_TEST_IDS } from '@/lib/automationDom'
import { MenuItem } from '../ui/Menu'

/** The chat's info (members, announcement, settings: one tab, owner 10-26), the same item in each menu that offers it. */
export function ChatDetailsMenuItems({ isGroupChat, onOpenInfo }: { isGroupChat: boolean; onOpenInfo: () => void }) {
  const { t } = useTranslation('messaging')
  return <MenuItem render={<button type="button" />} nativeButton data-testid={AUTOMATION_TEST_IDS.groupMenuSettings} onClick={onOpenInfo} icon={<Users size={16} />}>{t(isGroupChat ? 'header.groupInfo' : 'header.chatInfo')}</MenuItem>
}
