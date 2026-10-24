import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/Button'
import { useAuth } from '@/store/auth'
import { useDevicesStore } from '@/store/devicesContext'
import { retryDeviceSessions } from '@/session/shared/remote-sessions/session-directory'

/** Retry the existing directory writer, scoped to the signed-in owner and failed online devices. */
export function PhoneProjectDirectoryRetry({ deviceIds }: { deviceIds: readonly string[] }) {
  const { t } = useTranslation('assistant')
  const ownerId = useAuth().user?.id ?? null
  const { devices, refresh } = useDevicesStore()
  const scope = useRef({ ownerId, devices, epoch: 0 })
  scope.current = { ownerId, devices, epoch: scope.current.epoch + (scope.current.ownerId === ownerId ? 0 : 1) }
  const [request, setRequest] = useState({ epoch: -1, pending: false, error: null as string | null })
  const pending = request.epoch === scope.current.epoch && request.pending
  const error = request.epoch === scope.current.epoch ? request.error : null
  useEffect(() => () => { scope.current.epoch += 1 }, [])
  const retry = async () => {
    if (!ownerId || pending) return
    const epoch = scope.current.epoch
    const current = () => scope.current.epoch === epoch && scope.current.ownerId === ownerId
    setRequest({ epoch, pending: true, error: null })
    try {
      if (deviceIds.length === 0) await refresh()
      else for (const deviceId of new Set(deviceIds)) {
        if (!current()) return
        if (!scope.current.devices.some((device) => device.device_id === deviceId && device.is_online)) throw new Error('这台设备已不在当前账号的在线列表中。')
        await retryDeviceSessions(ownerId, deviceId)
      }
    } catch (cause) {
      if (current()) setRequest({ epoch, pending: false, error: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      if (current()) setRequest((value) => ({ ...value, pending: false }))
    }
  }
  return <>
    <Button className="ta-pill-btn" disabled={!ownerId || pending} onClick={() => void retry()} data-testid="phone-project-directory-retry">{t(pending ? 'library.loading' : 'machine.retry')}</Button>
    {error && <span role="alert">{error}</span>}
  </>
}
