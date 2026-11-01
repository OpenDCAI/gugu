import { useTranslation } from 'react-i18next'
import { Sheet } from '@/components/ui/Sheet'
import { sessionSkinClassName } from '@/components/sessionpage/sessionSkin'
import { useTheme } from '@/store/theme'
import { GlobalSearch } from '@/session/renderer/features/global-search/global-search'
import '@/session/renderer/index.css'

/**
 * 手机的搜索页:桌面那个搜索面板,全屏。手机上没有本机任务,所以只搜聊天;样式靠会话页的皮肤类,
 * 与手机应用市场的商品页(MobileAppsSection)同一种挂法。
 */
export function PhoneMessageSearch({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation('messaging')
  const { theme } = useTheme()
  return (
    <Sheet open={open} onClose={onClose} fullScreenMobile testId="phone-message-search" ariaLabel={t('chatList.searchMessagesTitle')}>
      {open ? <div className={`${sessionSkinClassName(theme)} h-full`}><GlobalSearch tasks={false} onClose={onClose} /></div> : null}
    </Sheet>
  )
}
