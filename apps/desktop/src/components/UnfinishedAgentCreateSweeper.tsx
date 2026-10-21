import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { rendererLogger } from '../lib/log'
import { cleanupStepsText } from '../lib/cleanupStageCopy'
import { sweepUnfinishedSingleAgents } from '../lib/unfinishedSingleAgentSweep'
import { useAuth } from '../store/auth'
import { useChatStore } from '../store/chatContext'
import { useToast } from './toastContext'

const sweepLog = rendererLogger('agents/unfinished-sweep')

/**
 * #6299 — 启动时收掉上次没建完的单 agent(见 lib/unfinishedSingleAgentSweep)。常挂载、渲染 null;
 * 每个登录用户每次启动只收一次,结果逐条如实提示。取代已下架的 AgentCreateRetryHost:
 * ❌ 不再弹旧式创建弹窗续建。
 */
export function UnfinishedAgentCreateSweeper({ active = true }: { active?: boolean }) {
  const { t, i18n } = useTranslation('agents')
  const { user } = useAuth()
  const { toast } = useToast()
  const { refreshChats } = useChatStore('refreshChats')
  const sweptFor = useRef<string | null>(null)
  const ownerUserId = active ? user?.id ?? null : null

  useEffect(() => {
    if (!ownerUserId || sweptFor.current === ownerUserId) return
    sweptFor.current = ownerUserId
    void sweepUnfinishedSingleAgents(ownerUserId).then(async (outcomes) => {
      let refresh = false
      for (const outcome of outcomes) {
        if (outcome.kind === 'discarded') {
          toast(t('create.unfinishedSweep.cancelled'), 'info')
        } else if (outcome.kind === 'cancelled') {
          toast(outcome.warningStages.length > 0
            ? t('create.unfinishedSweep.cancelledWithWarning', { steps: cleanupStepsText(outcome.warningStages, t, i18n.language) })
            : t('create.unfinishedSweep.cancelled'), outcome.warningStages.length > 0 ? 'warning' : 'info')
        } else if (outcome.kind === 'completed') {
          refresh = true
          toast(t('create.unfinishedSweep.completed', { name: outcome.session.agent.display_name }), 'success')
        } else {
          sweepLog.error({ operationId: outcome.operationId, stages: outcome.stages, err: outcome.error }, 'unfinished single agent could not be settled; record kept for next launch')
          toast(outcome.stages.length > 0
            ? t('create.unfinishedSweep.pending', { steps: cleanupStepsText(outcome.stages, t, i18n.language) })
            : t('create.unfinishedSweep.pendingError'), 'error')
        }
      }
      if (refresh) await refreshChats()
    }).catch((error: unknown) => {
      sweepLog.error({ err: error instanceof Error ? error.message : String(error) }, 'unfinished single agent sweep failed')
    })
  }, [ownerUserId, refreshChats, t, i18n.language, toast])

  return null
}
