import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { rpc } from '@renderer/lib/ipc'
import { rendererLogger } from '@/lib/log'
import { Progress } from '@/components/ui/Progress'

const log = rendererLogger('integrations/install-progress')

export type CliDownloadProgress = Awaited<ReturnType<typeof rpc.integrations.cliLoginProgress>>

/** 只看安装进度，不消费登录结果。未知总大小时保留不定进度，绝不按时间猜百分比。
 * 只有真在下载/安装（进度不为 null）才出现进度条和下载字样；已装好、云电脑预装、或读不到进度时只给 `idle`，
 * ❌ 把「正在准备连接」说成「正在准备下载」。 */
export function CliInstallProgress({ read, idle = null }: { read: () => Promise<CliDownloadProgress>; idle?: ReactNode }) {
  const { t } = useTranslation('assistant')
  const [progress, setProgress] = useState<CliDownloadProgress>(null)
  const [unreadable, setUnreadable] = useState(false)
  useEffect(() => {
    let cancelled = false
    let inFlight = false
    let reportedFailure = false
    const poll = async () => {
      if (inFlight) return
      inFlight = true
      try {
        const next = await read()
        if (!cancelled) { setProgress(next); setUnreadable(false); reportedFailure = false }
      } catch (error) {
        if (!cancelled) {
          setUnreadable(true)
          if (!reportedFailure) log.warn({ error: String(error) }, 'CLI install progress could not be read')
          reportedFailure = true
        }
      } finally { inFlight = false }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), 750)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [read])
  if (unreadable || !progress) return <>{idle}</>
  const total = progress.totalBytes
  const received = progress.receivedBytes
  const measured = progress.phase === 'download' && typeof total === 'number' && Number.isFinite(total) && total >= 1024 && Number.isFinite(received) && received >= 0
  const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1)
  // Small or unavailable totals have no useful MB ratio. Keep an honest, indeterminate track.
  const usefulRatio = measured && total >= 0.1 * 1024 * 1024
  return (
    <div className="grid gap-2 text-sm leading-6 text-[var(--muted-fg)]" role="status" data-testid="cli-install-progress">
      <Progress label={t('connectors.setup.downloadProgress')} value={measured ? Math.min(received / total * 100,100) : null} />
      <span>{progress.phase === 'install' ? t('connectors.setup.installing')
        : usefulRatio ? t('connectors.setup.downloadBytes', { received: mb(received), total: mb(total) })
        : received >= 0.1 * 1024 * 1024 ? t('connectors.setup.downloadReceived', { received: mb(received) })
        : t('connectors.setup.downloading')}</span>
    </div>
  )
}
