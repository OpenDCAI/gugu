import { useCallback, useEffect, useState } from 'react'
import type { AppSettings } from '@shared/core/app-settings'
import { machineRpc, onLinkChange } from './sessionpage-rpc'

/** This is the selected computer's setting, never the phone's local preference. */
export function useHostTerminalEnabled(deviceId: string, online: boolean) {
  const [reading, setReading] = useState<{ deviceId: string; enabled: boolean } | null>(null)
  const [revision, setRevision] = useState(0)
  const refresh = useCallback(() => setRevision((value) => value + 1), [])
  useEffect(() => {
    if (!online) return
    let active = true
    const read = () => {
      void (machineRpc(deviceId).appSettings.get('terminal') as Promise<AppSettings['terminal']>).then(
        (value) => { if (active) setReading({ deviceId, enabled: value.enabled === true }) },
        () => { if (active) setReading({ deviceId, enabled: false }) },
      )
    }
    const visible = () => { if (document.visibilityState === 'visible') read() }
    read()
    const stop = onLinkChange(deviceId, (open) => { if (open) read() })
    window.addEventListener('focus', read)
    document.addEventListener('visibilitychange', visible)
    return () => {
      active = false
      stop()
      window.removeEventListener('focus', read)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [deviceId, online, revision])
  return { enabled: online && reading?.deviceId === deviceId && reading.enabled, refresh }
}
