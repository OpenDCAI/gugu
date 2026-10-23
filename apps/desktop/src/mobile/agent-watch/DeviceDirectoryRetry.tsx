import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/Button'
import { useDevicesStore } from '@/store/devicesContext'

/** Device lookup has one writer; retry that writer instead of maintaining a second page-level list. */
export function DeviceDirectoryRetry() {
  const { t } = useTranslation('main')
  const { refresh, loading } = useDevicesStore()
  const [retrying, setRetrying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const retry = async () => {
    if (retrying || loading) return
    setRetrying(true)
    setError(null)
    try { await refresh() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setRetrying(false) }
  }
  return (
    <>
      <Button variant="secondary" size="lg" disabled={retrying || loading} data-testid="agent-watch-devices-retry" onClick={() => void retry()}>
        {t('agentWatch.timeline.reload')}
      </Button>
      {error ? <div role="alert" className="gg-aw-note-detail">{error}</div> : null}
    </>
  )
}
