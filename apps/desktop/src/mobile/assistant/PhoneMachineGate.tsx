import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/Button'
import { useCloudComputerWake } from '@/hooks/useWakeCloudComputer'
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'
import { AssistantEmpty } from '@/session/renderer/features/assistant/assistant-ui-parts'
import { usePhoneHome } from './phoneHome'
import type { PhoneReadiness } from './phoneMachine'

/**
 * 要读它家里东西的那几块(任务里的已安排、记忆),在读到之前说清是哪一步:正在连接(它住的云端宿主收回着时由系统叫起来,
 * owner 10-17 ❌「在休息 / 叫醒它」)/ 连不上(原因 + 重试)/ 连接断了(这一页开着时又被收回:重新连接)。
 * 连上才画 children。说的是它本人(`name`),❌ 说它住的机器。
 */
export function PhoneMachineGate({ readiness, name, children }: { readiness: PhoneReadiness; name: string; children: ReactNode }) {
  const { t } = useTranslation('assistant')
  const { t: tc } = useTranslation('common')
  const home = usePhoneHome()
  const cloud = home?.kind === 'cloud' && (readiness === 'asleep' || readiness === 'waking')
    ? { device_id: home.deviceId, cloud_computer: readiness === 'asleep' ? 'asleep' as const : 'waking' as const }
    : null
  const { issue, dropped, retry } = useCloudComputerWake(cloud)
  if (readiness === 'ready') return <>{children}</>
  if (issue || dropped)
    return (
      <AssistantEmpty
        action={<Button variant="ghost" className="ta-pill-btn" onClick={retry} data-testid="assistant-connect-retry">{issue ? t('machine.retry') : t('machine.reconnect')}</Button>}
      >
        <span role={issue ? 'alert' : 'status'} data-testid="assistant-connect-failed" data-kind={issue?.kind ?? 'dropped'}>
          {issue ? <>{t('machine.connectFailed', { name })}{tc(`cloudComputer.reason.${issue.kind}`)}</> : t('machine.dropped', { name })}
        </span>
      </AssistantEmpty>
    )
  if (readiness === 'unreachable') {
    // 住人自己的电脑上:那台开着它才在,没开 / 不在设备里就照实说(❌ 说连不上云)。
    if (home?.kind === 'computer')
      return (
        <AssistantEmpty>
          {home.known
            ? t('machine.computerOff', { name, device: home.label ?? t('home.thatComputer') })
            : t('machine.computerGone', { name })}
        </AssistantEmpty>
      )
    return <AssistantEmpty>{t('machine.unreachable', { name })}</AssistantEmpty>
  }
  return (
    <AssistantEmpty>
      <span className="inline-flex items-center gap-2" role="status" data-testid="assistant-connecting">
        <LoadingIndicator size="inline" />
        {t('machine.connecting', { name })}
      </span>
    </AssistantEmpty>
  )
}
