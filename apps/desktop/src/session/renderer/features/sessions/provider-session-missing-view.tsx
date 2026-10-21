import { observer } from 'mobx-react-lite'
import { useState } from 'react'
import { Archive, RefreshCw } from '@/lib/icons'
import { requestArchiveSession } from '@renderer/features/sessions/archive-session-flow'
import { sessionRegistry } from '@renderer/features/sessions/stores/session-registry'
import { Button } from '@renderer/lib/ui/button'
import { log } from '@renderer/utils/logger'
import { useSessionMessages } from '@renderer/localization/use-session-messages'

/**
 * spec session-resume:引擎侧没有这条会话时的出路是**照记着的首轮重来**(= restart),
 * 而不是「新建一条」。
 *
 * 这里原来摆的是「新建对话」——它把用户领去造一条全新的会话,坏掉的那条原样留在列表里:
 * 既没修好,又多了一条。会话 id、标题、在任务里的位置都该原样保留,重来的是那句首轮。
 * 重来本身失败(连接断、引擎起不来)就如实报出来,❌ 不静默换一条冒充成功。
 *
 * **存量空壳会话**是唯一走不通的那种:它建出来时就没带第一句话(那条路已经堵死,见
 * buildSessionRow),既无历史可恢复,也无首轮可重来。对它只剩一个出路 —— 把它从列表里收起。
 * 收起就是归档(#6949:人这一侧没有删除),与会话列表那一行、⋯ 菜单同一条 archive-session-flow。
 * ❌ 不把用户留在一句错误提示前面无路可走(spec session-resume 底线)。
 */
export const ProviderSessionMissingView = observer(function ProviderSessionMissingView({
  sessionId,
  onRestarted
}: {
  sessionId: string
  /** 重来成功后本地要做的那一步(ACP 面板得重新 bootstrap;pty 由主进程直接重起)。 */
  onRestarted?: () => void
}) {
  const { translate } = useSessionMessages()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 有没有可重来的首轮,**进这个界面之前就知道** —— ❌ 不摆一个点下去才发现不行的按钮。
  const nothingToReplay = !sessionRegistry
    .get(sessionId)
    ?.sessions.get(sessionId)?.data.firstUtterance

  const handleRestart = () => {
    if (busy) return
    setBusy(true)
    setError(null)
    void sessionRegistry
      .get(sessionId)
      ?.restartSession(sessionId)
      .then(() => onRestarted?.())
      .catch((e: unknown) => {
        log.error('restart session failed', e)
        setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => setBusy(false))
  }

  const handleArchive = () => {
    if (busy) return
    const session = sessionRegistry.get(sessionId)?.sessions.get(sessionId)
    if (!session) return
    requestArchiveSession({ projectId: session.data.projectId, sessionId })
  }

  return (
    <div
      className="flex h-full min-h-0 flex-1 items-center justify-center bg-background-secondary-1 px-6"
      data-provider-session-state="missing"
    >
      <div className="flex max-w-md flex-col items-center gap-2 text-center">
        <RefreshCw className="mb-1 size-5 text-foreground-muted" aria-hidden="true" />
        <h2 className="text-sm font-medium text-foreground">
          {translate('chat.providerSessionMissingTitle')}
        </h2>
        <p className="text-xs leading-5 text-foreground-muted">
          {translate(
            nothingToReplay
              ? 'chat.providerSessionMissingLegacyDescription'
              : 'chat.providerSessionMissingDescription'
          )}
        </p>
        {nothingToReplay ? (
          <Button
            size="sm"
            className="mt-2 gap-1"
            disabled={busy}
            data-testid="provider-session-missing-archive"
            onClick={handleArchive}
          >
            <Archive className="size-3.5" aria-hidden="true" />
            {translate('task.archiveTaskTitle')}
          </Button>
        ) : (
          <Button size="sm" className="mt-2 gap-1" disabled={busy} onClick={handleRestart}>
            <RefreshCw className="size-3.5" aria-hidden="true" />
            {translate(
              busy ? 'chat.providerSessionMissingActionBusy' : 'chat.providerSessionMissingAction'
            )}
          </Button>
        )}
        {error && <p className="text-foreground-destructive text-xs">{error}</p>}
      </div>
    </div>
  )
})
