import { useTranslation } from 'react-i18next'
import type { Device } from '@gugu/core/shared/types/chat'
import { Button } from '../../components/ui/Button'
import type { CloudComputerWakeIssue } from '../../hooks/useWakeCloudComputer'

/**
 * #7199 手机上打开 / 新建一条在没醒着的云电脑上的会话:页顶那一行(占离线说明那一格)。这一页挂上就在叫醒它,所以只说
 * 「正在连接」或没叫醒的原因 —— ❌ 说「离线，打不开」,也 ❌ 说「在休息」(owner 10-17:Agent 没有休息这回事)。
 */
export function CloudComputerNote({ device, issue, dropped = false, onRetry }: {
  device: Pick<Device, 'cloud_computer'>
  issue: CloudComputerWakeIssue | null
  /** 这一页开着时它又被收回了(叫过一次、此刻没在叫):说「连接断了」+ 重新连接,❌ 一直「正在连接」。 */
  dropped?: boolean
  onRetry?: () => void
}) {
  const { t } = useTranslation('main')
  const { t: tc } = useTranslation('common')
  const text = issue
    ? issue.kind === 'credits_exhausted'
      ? t('agentWatch.cloud.creditsExhausted')
      : `${t('agentWatch.cloud.wakeFailed')}${tc(`cloudComputer.reason.${issue.kind}`)}`
    : dropped
      ? t('agentWatch.cloud.dropped')
      : t('agentWatch.cloud.connecting')
  return (
    <div className="gg-aw-offline" data-testid="agent-watch-cloud-computer-note" data-state={issue ? 'failed' : dropped ? 'dropped' : device.cloud_computer}>
      <div className="gg-aw-offline-line" role={issue ? 'alert' : 'status'}>
        <span className="gg-aw-offline-text">{text}</span>
        {(issue || dropped) && onRetry ? (
          <Button size="sm" variant="ghost" onClick={onRetry} data-testid="agent-watch-cloud-computer-retry">
            {issue ? t('agentWatch.cloud.retry') : t('agentWatch.cloud.reconnect')}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
