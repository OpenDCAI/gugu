import { useTranslation } from 'react-i18next'
import { Bell, Settings } from '@/lib/icons'
import { AUTOMATION_TEST_IDS } from '@/lib/automationDom'
import { MenuItem } from '../ui/Menu'

/** The same conversation actions in the header and the tab's context menu. */
export function ChatDetailsMenuItems({ isGroupChat, onOpenSettings, onOpenAnnouncement }: {
  isGroupChat: boolean
  onOpenSettings: () => void
  onOpenAnnouncement: () => void
}) {
  const { t } = useTranslation('messaging')
  return <>
    {isGroupChat && <MenuItem render={<button type="button" />} nativeButton data-testid={AUTOMATION_TEST_IDS.groupMenuAnnouncement} onClick={onOpenAnnouncement} icon={<Bell size={16} />}>{t('header.announcement')}</MenuItem>}
    <MenuItem render={<button type="button" />} nativeButton data-testid={AUTOMATION_TEST_IDS.groupMenuSettings} onClick={onOpenSettings} icon={<Settings size={16} />}>{t('common.settings')}</MenuItem>
  </>
}
