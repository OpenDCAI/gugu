import { useState } from 'react'
import type { AgentInstallProgress } from '@gugu/session-core/workspace-server'
import { Button } from '@renderer/lib/ui/button'
import { useSessionMessages } from '@renderer/localization/use-session-messages'
import { installProgressLine } from './install-progress-line'

/**
 * 安装进行中那一格：一句「在干什么、到哪了、多快、还要多久」＋ 取消 ＋ 一条进度条。
 *
 * 单独成件有两个理由，都不是为了好看：
 * - **只在装的时候挂载**，所以「已经按过取消」这一格状态随每次安装重新开始。挂在卡片上时它
 *   永不复位 —— 取消过一次之后再装，取消按钮就一直是灰的。
 * - 条子的**实际宽度**是这一格唯一能判真假的东西，而它只在真排版之后才存在；单独成件才能
 *   在真浏览器里把它量出来（tests/browser/agents-install-progress-5719.test.tsx）。
 */
export function InstallProgressRow({
  progress,
  onCancel,
  compact = false
}: {
  progress: AgentInstallProgress | null
  onCancel: () => void
  compact?: boolean
}) {
  const { translate } = useSessionMessages()
  const [cancelRequested, setCancelRequested] = useState(false)
  const line = installProgressLine(progress, translate)
  const heading =
    progress?.phase === 'downloading'
      ? [
          progress.part && `${progress.part.name} ${progress.part.index}/${progress.part.count}`,
          translate('agentsPage.phaseDownloadingPackage')
        ]
          .filter(Boolean)
          .join(' · ')
      : (line?.heading ?? translate('agentsPage.phaseStarting'))

  return (
    <>
      <div className="flex min-h-9 items-center gap-3">
        {/* 实测读数优先；这一拍还没有读数时才退回那句「装到咕咕自己的目录」。
            ❌ 不给一个「正在安装…」了事 —— 那正是 owner 说的「提心吊胆，等半天」。 */}
        <div className="min-w-0 text-xs/5 text-foreground-muted">
          <p className="m-0" data-testid="install-progress-heading">
            {compact ? (
              <>
                {heading}
                {line?.ratio != null && ` · ${Math.round(line.ratio * 100)}%`}
              </>
            ) : (
              (line?.text ?? translate('agentsPage.installingToGuguHome'))
            )}
          </p>
          {compact && line?.detail && <p className="m-0">{line.detail}</p>}
        </div>
        {/* 能等就能取消（product spec）。按下之后立刻禁用，
            因为中止是一趟往返，重复按只会发第二条没用的请求。 */}
        <Button
          size="sm"
          variant="outline"
          className="ml-auto shrink-0"
          disabled={cancelRequested}
          onClick={() => {
            setCancelRequested(true)
            onCancel()
          }}
        >
          {translate('agentsPage.installCancel')}
        </Button>
      </div>
      {(!compact || line?.ratio != null) && (
        <div
          data-testid="install-progress-track"
          className="mt-1 h-1.5 overflow-hidden rounded-full bg-background-2"
        >
          {/* 设置行只画有真实分母的进度；其他既有入口保留原有未知进度样式。 */}
          {line !== null && line.ratio !== null ? (
            <span
              data-testid="install-progress-determinate"
              className={
                compact
                  ? 'block h-full bg-foreground transition-[width] duration-500 motion-reduce:transition-none'
                  : 'block h-full bg-foreground-info transition-[width] duration-500 motion-reduce:transition-none'
              }
              style={{ width: `${Math.round(line.ratio * 100)}%` }}
            />
          ) : (
            <span
              data-testid="install-progress-indeterminate"
              className={
                compact
                  ? 'gg-progress-indeterminate block h-full w-[38%] bg-foreground'
                  : 'gg-progress-indeterminate block h-full w-[38%] bg-foreground-info'
              }
            />
          )}
        </div>
      )}
    </>
  )
}
