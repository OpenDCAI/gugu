import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Sheet } from '@/components/ui/Sheet'
import { sessionSkinClassName } from '@/components/sessionpage/sessionSkin'
import { useTheme } from '@/store/theme'
import { useCommandProvider } from '@renderer/lib/commands/use-command-provider'
import { GlobalSearch } from '@/session/renderer/features/global-search/global-search'
import '@/session/renderer/index.css'

/**
 * 手机壳,以及没有会话页(任务工作区)的地方,搜索面板挂在这里:桌面那个搜索面板,手机上全屏。它接
 * app.globalSearch,所以每个入口(会话列表最后一行、会话里的「搜索聊天记录」、⌘F、「查找 TA 的消息」)都只调
 * openGlobalSearch。这里没有本机任务,所以只搜聊天;样式靠会话页的皮肤类,与手机应用市场的商品页同一种挂法。
 */
export function PhoneMessageSearch() {
  const { t } = useTranslation('messaging')
  const { theme } = useTheme()
  const [open, setOpen] = useState(false)
  useCommandProvider({ scopeId: 'app', getCommands: () => [{ id: 'app.globalSearch', hideFromPalette: true, execute: () => setOpen(true) }] })
  const close = () => setOpen(false)
  return (
    <Sheet open={open} onClose={close} fullScreenMobile testId="phone-message-search" ariaLabel={t('chatList.searchMessagesTitle')}>
      {open ? <div className={`${sessionSkinClassName(theme)} h-full`}><GlobalSearch tasks={false} onClose={close} onOpen={close} /></div> : null}
    </Sheet>
  )
}
