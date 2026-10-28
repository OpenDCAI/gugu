import { useTranslation } from 'react-i18next'
import { IconButton } from '@/components/ui/IconButton'
import { ExternalLink } from '@/lib/icons'
import { APP_SHOW_SESSION_EVENT, type AppShowSessionDetail } from '@/session/shared/extensions/app-runtime-protocol'
import type { SessionDirectoryRow } from '@/session/shared/remote-sessions/session-directory'

/**
 * Agent 私聊页头那一颗「在任务中打开」(#639 搬到手机):电脑把私聊页头的模式菜单换成了一颗按钮,手机跟着换,
 * ❌ 「对话 / 项目」下拉。只画图标(私聊页头放不下名字),名字进读屏标签。
 * 去处 = 与 App 点名一条会话(`gugu.showSession`)同一条跳转:任务 tab 打开它那一页。
 */
export function MobileAgentOpenTask({ row }: { row: SessionDirectoryRow }) {
  const { t } = useTranslation('messaging')
  const label = t('agent.taskpage.open')
  const open = (): void => {
    const detail: AppShowSessionDetail = { deviceId: row.deviceId, session: row.session }
    window.dispatchEvent(new CustomEvent(APP_SHOW_SESSION_EVENT, { detail }))
  }
  return (
    <IconButton size="lg" aria-label={label} title={label} data-testid="agent-open-task" onClick={open}>
      <ExternalLink />
    </IconButton>
  )
}
