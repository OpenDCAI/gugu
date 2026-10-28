import { messageForUser } from '@/lib/userFacingError';
import { useRef, useState, type ReactNode } from 'react'
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
export function FirstRunInstallProvider({ children, showNotification = true }: { children: ReactNode; showNotification?: boolean }) {
  const { t } = useTranslation('main')
  const { translate } = useSessionMessages()
  const installation = useAgentInstallationStatuses()
  const [tasks, setTasks] = useState<InstallTask[]>([])
  const [hidden, setHidden] = useState(false)
  const update = (task: InstallTask) => setTasks((current) => current.some((item) => item.id === task.id)
    ? current.map((item) => item.id === task.id ? task : item)
    : [...current, task])

  // 选 Agent 那页能退回再「继续」(规范:每页有上一步):已在装 / 装好的 ❌ 再排一次 —— 再排会撞上
  // 「已有安装在进行」报错。失败的照常能重试。
  const current = useRef(tasks)
  current.current = tasks
  const start = (ids: FirstRunHarness[]) => {
    setHidden(false)
    for (const id of ids) {
      const known = current.current.find((task) => task.id === id)
      if (known && known.state !== 'failed') continue
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
          }).catch((error: unknown) => update({ id, state: 'failed', error: messageForUser(error) }))
      }).catch((error: unknown) => update({ id, state: 'failed', error: messageForUser(error) }))
    }
  }

  return (
    <FirstRunInstallContext.Provider value={start}>
      {children}
      {showNotification && tasks.length > 0 && !hidden ? (
        <aside className="first-run-install-notification" aria-label={t('firstRun.backgroundInstall')} aria-live="polite" data-testid="first-run-install-notification">
          <div className="first-run-install-notification-heading">
            <strong>{t('firstRun.backgroundInstall')}</strong>
            <Button size="sm" variant="ghost" onClick={() => setHidden(true)}>{t('firstRun.hideInstall')}</Button>
          </div>
          {tasks.map((task) => <InstallTaskRow key={task.id} task={task} onRetry={() => start([task.id])}
            onCancel={() => { void rpc.agents.cancelInstall(task.id).catch((error: unknown) => update({ ...task, error: messageForUser(error) })) }} />)}
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
