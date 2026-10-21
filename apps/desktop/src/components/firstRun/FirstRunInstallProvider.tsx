import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { FirstRunHarness } from '@gugu/core/shared/firstRun'
import { useAgentInstallationStatuses, useAgentInstallProgress } from '@renderer/lib/stores/use-agent-installation-statuses'
import { InstallProgressRow } from '@renderer/features/settings/agents-page/InstallProgressRow'
import { getAgentInstallErrorPresentation } from '@renderer/features/settings/agents-page/agent-install'
import { useSessionMessages } from '@renderer/localization/use-session-messages'
import { rpc } from '@renderer/lib/ipc'
import { Button } from '../ui/Button'
import { FirstRunInstallContext } from './first-run-install-context'

type InstallTask = { id: FirstRunHarness; state: 'installing' | 'done' | 'failed'; error?: string }

/** 跨引导步骤和主界面常驻；页面切换不会取消安装，也不会丢掉失败后的重试入口。 */
export function FirstRunInstallProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation('main')
  const { translate } = useSessionMessages()
  const installation = useAgentInstallationStatuses()
  const [tasks, setTasks] = useState<InstallTask[]>([])
  const [hidden, setHidden] = useState(false)
  const update = (task: InstallTask) => setTasks((current) => current.some((item) => item.id === task.id)
    ? current.map((item) => item.id === task.id ? task : item)
    : [...current, task])

  const start = (ids: FirstRunHarness[]) => {
    setHidden(false)
    for (const id of ids) {
      update({ id, state: 'installing' })
      void installation.installAsync({ id, method: 'mise' }).then((result) => {
          if (!result.success) {
            update({ id, state: 'failed', error: getAgentInstallErrorPresentation(result.error, { translate }).message })
            return
          }
          void rpc.agents.getAgentInstallationStatus(id).then((status) => {
            const managedReady = status?.used.kind === 'method' && status.used.method === 'mise'
              && status.installations.some((copy) => copy.provenance.ours && copy.provenance.kind === 'mise' && copy.status === 'available')
            update(managedReady
              ? { id, state: 'done' }
              : { id, state: 'failed', error: t('firstRun.harnessVerifyFailed') })
          }).catch(() => update({ id, state: 'failed', error: t('firstRun.harnessReadFailed') }))
      }).catch((error: unknown) => update({ id, state: 'failed', error: error instanceof Error ? error.message : t('firstRun.harnessVerifyFailed') }))
    }
  }

  return (
    <FirstRunInstallContext.Provider value={start}>
      {children}
      {tasks.length > 0 && !hidden ? (
        <aside className="first-run-install-notification" aria-label={t('firstRun.backgroundInstall')} aria-live="polite" data-testid="first-run-install-notification">
          <div className="first-run-install-notification-heading">
            <strong>{t('firstRun.backgroundInstall')}</strong>
            <Button size="sm" variant="ghost" onClick={() => setHidden(true)}>{t('firstRun.hideInstall')}</Button>
          </div>
          {tasks.map((task) => <InstallTaskRow key={task.id} task={task} onRetry={() => start([task.id])}
            onCancel={() => { void rpc.agents.cancelInstall(task.id).catch(() => update({ ...task, error: t('firstRun.harnessCancelFailed') })) }} />)}
        </aside>
      ) : null}
    </FirstRunInstallContext.Provider>
  )
}

function InstallTaskRow({ task, onRetry, onCancel }: { task: InstallTask; onRetry: () => void; onCancel: () => void }) {
  const { t } = useTranslation('main')
  const progress = useAgentInstallProgress(task.id, task.state === 'installing')
  return (
    <div className="first-run-install-task">
      <div className="first-run-install-task-heading">
        <span>{task.id === 'codex' ? 'Codex' : 'Claude'}</span>
        {task.state === 'done' ? <span>{t('firstRun.harnessInstalled')}</span> : null}
        {task.state === 'failed' ? <Button size="sm" variant="ghost" onClick={onRetry}>{t('firstRun.retry')}</Button> : null}
      </div>
      {task.state === 'installing' ? <InstallProgressRow progress={progress} onCancel={onCancel} /> : null}
      {task.error ? <p className="ta-onb-error" role="alert">{task.error}</p> : null}
    </div>
  )
}
