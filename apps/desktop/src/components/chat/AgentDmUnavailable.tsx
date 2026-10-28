import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentDmSession } from '../../hooks/useAgentDmSession'
import { rendererLogger } from '../../lib/log'
import { Button } from '../ui/Button'
import { PaneEmptyState } from '../ui/PaneEmptyState'

const log = rendererLogger('chat/agent-dm')

/**
 * 和 agent 的私聊打不开那条会话时,消息区里就说这一句(还在找 / 没有会话 / 电脑离线 / 没打开)并给重试 ——
 * ❌ 退回老的气泡列表(owner 10-27:私聊只有任务页那一种界面)。桌面项目页与手机私聊共用。
 * 没打开的原因只进日志,用户看到的是下一步(#4891)。
 */
export function AgentDmUnavailable({ session, onRetry }: {
  session: Exclude<AgentDmSession, { state: 'ready' }>
  onRetry: () => void
}) {
  const { t } = useTranslation('messaging')
  const failure = session.state === 'failed' ? session.message : null
  useEffect(() => {
    if (failure) log.warn({ error: failure }, 'agent dm: session could not be opened')
  }, [failure])
  const caption = {
    resolving: t('agent.dm.resolving'),
    'no-session': t('agent.dm.noSession'),
    'machine-offline': t('agent.dm.machineOffline'),
    failed: t('agent.dm.failed'),
  }[session.state]
  return (
    <div data-testid="agent-dm-unavailable" data-state={session.state} className="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-3">
      <PaneEmptyState caption={caption} />
      {session.state === 'resolving' ? null : (
        <Button variant="secondary" size="sm" onClick={onRetry}>{t('agent.dm.retry')}</Button>
      )}
    </div>
  )
}
