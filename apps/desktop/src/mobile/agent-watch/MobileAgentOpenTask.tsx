import { useTranslation } from 'react-i18next'
import { IconButton } from '@/components/ui/IconButton'
import { ExternalLink } from '@/lib/icons'
import { followLink } from '@/lib/guguLinks'
import type { SessionDirectoryRow } from '@/session/shared/remote-sessions/session-directory'

/**
 * Agent 私聊页头那一颗「在任务中打开」(#639 搬到手机):电脑把私聊页头的模式菜单换成了一颗按钮,手机跟着换,
 * ❌ 「对话 / 项目」下拉。只画图标(私聊页头放不下名字),名字进读屏标签。
 * 去处 = 打开会话的那一条路(followLink):任务 tab 打开它那一页。
 */
export function MobileAgentOpenTask({ row }: { row: SessionDirectoryRow }) {
  const { t } = useTranslation('messaging')
  const label = t('agent.taskpage.open')
  const open = (): void => { followLink({ kind: 'session', sessionId: row.session.conversationId, deviceId: row.deviceId }) }
  return (
    <IconButton size="lg" aria-label={label} title={label} data-testid="agent-open-task" onClick={open}>
      <ExternalLink />
    </IconButton>
  )
}
